import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTutorMarkingApplication, prepareMarkedReportSource } from '../../examples/tutor-marking/application.js';
import { runMarkingAcceptance } from '../../examples/tutor-marking/acceptance.js';
import { TutorMarkingFixtureDriver } from '../../examples/tutor-marking/fixture-driver.js';
import type { MarkingFixtureMode } from '../../examples/tutor-marking/fixture-driver.js';
import { createTutorReportApplication } from '../../examples/tutor-report/application.js';
import { TutorReportFixtureDriver, fixtureContext, fixtureProgram } from '../../examples/tutor-report/fixture-driver.js';
const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;

test('marking releases a failed downstream execution before its borrowed predecessor', { skip: !workspace || !python, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-marking-cleanup-')); t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)(python!, [fixtureProgram, 'source', '--workspace', workspace!, '--output', join(root, 'fixture')], { timeout: 30000 });
  await mkdir(join(root, 'bundle')); await cp(join(root, 'fixture/source'), join(root, 'bundle/source'), { recursive: true });
  let cleaned = false, released = false;
  const app = await createTutorMarkingApplication(join(root, 'run'), { source: join(root, 'bundle'), tutorWorkspace: workspace!, python: python!,
    marker: { id: 'marker', prompt: 'fixture', config: { role: 'marker', mode: 'correct' } }, reviewer: { id: 'reviewer', prompt: 'fixture', config: { role: 'reviewer', mode: 'correct' } },
    driver: store => {
      const inner = new TutorMarkingFixtureDriver(store, join(root, 'agents'), join(root, 'fixture/candidate'));
      return { harness: inner.harness, validate: inner.validate.bind(inner), async run(task, input) {
        const handle = await inner.run(task, input);
        return { get facts() { return { ...handle.facts, finalized: cleaned, runner: { ...handle.facts.runner, stop: cleaned ? 'confirmed' as const : 'unknown' as const } }; },
          async retryCleanup() { cleaned = true; }, async release() { assert.equal(cleaned, true); await handle.release(); released = true; } };
      } };
    } });
  const run = await app.run('cleanup'); assert.equal(run.snapshot.status, 'failed');
  await app.release(run); assert.equal(released, true);
  assert.deepEqual(await readdir(join(root, 'run/artifacts')), []); assert.deepEqual(await readdir(join(root, 'run/nodes')), []);
});
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


test('shared acceptance preserves fixture classification and explicit source limits', { skip: !workspace || !python, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-marking-acceptance-')); t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)(python!, [fixtureProgram, 'source', '--workspace', workspace!, '--output', join(root, 'fixture')], { timeout: 30000 });
  await mkdir(join(root, 'bundle')); await cp(join(root, 'fixture/source'), join(root, 'bundle/source'), { recursive: true });
  const bindings = { marker: { id: 'marker', prompt: 'fixture', config: { role: 'marker', mode: 'correct' } },
    reviewer: { id: 'reviewer', prompt: 'fixture', config: { role: 'reviewer', mode: 'correct' } } };
  const rejected = await createTutorMarkingApplication(join(root, 'small'), { source: join(root, 'bundle'), tutorWorkspace: workspace!, python: python!, ...bindings,
    maxSourceBytes: 1, driver: store => new TutorMarkingFixtureDriver(store, join(root, 'small-agents'), join(root, 'fixture/candidate')) });
  await assert.rejects(rejected.run('too-large'));
  assert.equal(rejected.driver.tasks.length, 0);
  let calls = 0;
  const summary = await runMarkingAcceptance({ root: join(root, 'accepted'), source: join(root, 'bundle'), tutorWorkspace: workspace!, python: python!,
    ...bindings, reporter: { id: 'reporter', prompt: 'fixture', config: { mode: 'correct' } }, context: fixtureContext,
    maxSourceBytes: 512 * 1024 ** 2, syntheticMaterial: true, realModels: false,
    driver: store => ++calls === 1 ? new TutorMarkingFixtureDriver(store, join(root, 'agents'), join(root, 'fixture/candidate'))
      : new TutorReportFixtureDriver(store, join(root, 'report-agents'), workspace!, python!) });
  assert.equal(summary.passed, true); assert.equal(summary.realModels, false); assert.equal(summary.syntheticMaterial, true);
  assert.equal(summary.executions.length, 3); assert.equal(calls, 2);
  assert.ok(summary.executions.every(record => (record as { released: boolean }).released));
  assert.equal(JSON.parse(await readFile(join(root, 'accepted/report/render-manifest.json'), 'utf8')).total_sheets, 3);
});
