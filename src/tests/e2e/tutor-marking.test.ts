import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTutorMarkingApplication, prepareMarkedReportSource } from '../../examples/tutor-marking/application.js';
import { TutorMarkingFixtureDriver } from '../../examples/tutor-marking/fixture-driver.js';
import type { MarkingFixtureMode } from '../../examples/tutor-marking/fixture-driver.js';
import { createTutorReportApplication } from '../../examples/tutor-report/application.js';
import { TutorReportFixtureDriver, fixtureContext, fixtureProgram } from '../../examples/tutor-report/fixture-driver.js';
const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;
const scenarios = ['correct', 'stale-hash', 'low-quality', 'failed-check', 'source-tamper', 'review-tamper', 'invalid-candidate', 'repair', 'exhausted', 'no-repair'] as const;
for (const scenario of scenarios) test(`Tutor scanned marking ${scenario} via real file Workflow and installed business gates`, { skip: !workspace || !python, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-tutor-marking-')); t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)(python!, [fixtureProgram, 'source', '--workspace', workspace!, '--output', join(root, 'fixture')],
    { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  await mkdir(join(root, 'bundle')); await cp(join(root, 'fixture/source'), join(root, 'bundle/source'), { recursive: true });
  const originalPath = join(root, 'bundle/source/input/marking-input.json'), before = await readFile(originalPath);
  const mode: MarkingFixtureMode = ['repair', 'exhausted', 'no-repair'].includes(scenario) ? 'reject' : scenario as MarkingFixtureMode;
  const repaired = scenario === 'repair' || scenario === 'exhausted';
  const app = await createTutorMarkingApplication(join(root, 'run'), { source: join(root, 'bundle'), tutorWorkspace: workspace!, python: python!,
    marker: { id: 'my-marker', prompt: 'Synthetic marker', config: { role: 'marker', mode: scenario === 'invalid-candidate' ? mode : 'correct' } },
    reviewer: { id: 'my-reviewer', prompt: 'Synthetic independent reviewer', config: { role: 'reviewer', mode: scenario === 'invalid-candidate' ? 'correct' : mode } },
    ...(repaired ? { repair: { agent: { id: 'user-chosen-fixer', prompt: 'Synthetic user repair', config: { role: 'repair', mode: scenario === 'repair' ? 'correct' : 'reject' } }, maxRounds: scenario === 'repair' ? 1 : 3 } } : {}),
    driver: store => new TutorMarkingFixtureDriver(store, join(root, 'agents'), join(root, 'fixture/candidate')) });
  const run = await app.run('scan-test');
  try {
    assert.deepEqual(await readFile(originalPath), before);
    if (scenario === 'correct' || scenario === 'repair') {
      assert.equal(run.snapshot.status, 'succeeded', JSON.stringify(run.snapshot)); assert.equal(run.snapshot.outcome, 'completed', JSON.stringify(run.snapshot));
      assert.equal(run.snapshot.steps.length, scenario === 'correct' ? 5 : 8);
      await app.exportMarked('scan-test', join(root, 'marked'));
      const acceptedCandidate = JSON.parse(await readFile(join(root, 'marked/candidate/marking-candidate.json'), 'utf8'));
      assert.match(acceptedCandidate.item_results[0].feedback.summary, /independently checked/);
      assert.notDeepEqual(await readFile(join(root, 'marked/candidate/marking-candidate.json')), await readFile(join(root, 'fixture/candidate/marking-candidate.json')));
      await prepareMarkedReportSource(join(root, 'marked'), join(root, 'report-source'));
      if (scenario === 'correct') {
        const report = await createTutorReportApplication(join(root, 'report'), { source: join(root, 'report-source'), tutorWorkspace: workspace!, python: python!, context: fixtureContext,
          reporter: { id: 'reporter', prompt: 'Synthetic report', config: { mode: 'correct' } }, driver: store => new TutorReportFixtureDriver(store, join(root, 'report-agents'), workspace!, python!) });
        const reported = await report.run('scan-report');
        try {
          assert.equal(reported.snapshot.outcome, 'completed', JSON.stringify(reported.snapshot));
          const final = reported.snapshot.lastAccepted!.result;
          assert.equal(final.status, 'accepted'); if (final.status !== 'accepted') throw new Error('REPORT_FAILED');
          await report.files.materialize(final.output, 'scan-report', join(root, 'rendered'));
          assert.equal((await readFile(join(root, 'rendered/report.pdf'))).subarray(0, 5).toString(), '%PDF-');
          assert.equal(JSON.parse(await readFile(join(root, 'rendered/render-manifest.json'), 'utf8')).total_sheets, 3);
        } finally { await report.release(reported); }
        assert.equal(report.driver.live.size, 0);
      }
    } else {
      if (scenario === 'source-tamper' || scenario === 'review-tamper') assert.equal(run.snapshot.status, 'failed', JSON.stringify(run.snapshot));
      else assert.equal(run.snapshot.outcome, scenario === 'invalid-candidate' ? 'invalid' : 'rejected', JSON.stringify(run.snapshot));
      await assert.rejects(app.exportMarked('scan-test', join(root, 'must-not-exist')), /PASSED_MARKING_REQUIRED/);
      if (scenario === 'invalid-candidate') assert.equal(app.driver.tasks.length, 1);
      if (scenario === 'exhausted') assert.equal(app.driver.tasks.filter(task => (task.config as { role: string }).role === 'repair').length, 3);
      if (scenario === 'no-repair') assert.equal(app.driver.tasks.length, 2);
    }
  } finally { await app.release(run); }
  assert.equal(app.driver.live.size, 0); assert.deepEqual(await readdir(join(root, 'run/artifacts')), []); assert.deepEqual(await readdir(join(root, 'run/nodes')), []);
});
