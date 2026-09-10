import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTutorReportApplication } from '../../examples/tutor-report/application.js';
import { TutorReportFixtureDriver, fixtureContext, fixtureProgram } from '../../examples/tutor-report/fixture-driver.js';

const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;
for (const mode of ['correct', 'bad-report', 'source-tamper', 'timeout'] as const) test(`installed Tutor consumer ${mode} through the actual TS file Workflow`,
  { skip: !workspace || !python, timeout: 120000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'af-tutor-report-')); t.after(() => rm(root, { recursive: true, force: true }));
    await promisify(execFile)(python!, [fixtureProgram, 'source', '--workspace', workspace!, '--output', join(root, 'bundle')],
      { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const source = join(root, 'bundle'), before = await readFile(join(source, 'source/input/marking-input.json'));
    const app = await createTutorReportApplication(join(root, 'run'), { tutorWorkspace: workspace!, python: python!, source, context: fixtureContext,
      reporter: { id: 'reporter', prompt: 'Synthetic Reporter fixture.', config: { mode: mode === 'timeout' ? 'correct' : mode } },
      ...(mode === 'timeout' ? { toolTimeoutMs: 1 } : {}),
      driver: store => new TutorReportFixtureDriver(store, join(root, 'agent'), workspace!, python!) });
    const run = await app.run('report-test');
    try {
      assert.deepEqual(await readFile(join(source, 'source/input/marking-input.json')), before);
      if (mode === 'correct') {
        assert.equal(run.snapshot.status, 'succeeded', JSON.stringify(run.snapshot)); assert.equal(run.snapshot.outcome, 'completed');
        assert.deepEqual(run.snapshot.steps.map(s => s.node), ['prepare', 'reporter', 'gate', 'render']);
        const final = run.snapshot.lastAccepted?.result; assert.equal(final?.status, 'accepted');
        if (final?.status !== 'accepted') throw new Error('REPORT_NOT_ACCEPTED');
        await app.files.materialize(final.output, 'report-test', join(root, 'accepted'));
        const manifest = JSON.parse(await readFile(join(root, 'accepted/render-manifest.json'), 'utf8'));
        assert.equal(manifest.template, 'integrated-a3-v1'); assert.equal(manifest.submission_pages, 1); assert.ok(manifest.total_sheets >= 3);
        assert.equal((await readFile(join(root, 'accepted/report.pdf'))).subarray(0, 5).toString(), '%PDF-');
        const checked = await promisify(execFile)(python!, ['-c', 'from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); assert len(r.pages)>=3; assert all(float(p.mediabox.width)>float(p.mediabox.height) for p in r.pages); print(len(r.pages))', join(root, 'accepted/report.pdf')]);
        assert.ok(Number(checked.stdout) >= 3);
      } else {
        assert.ok(!run.snapshot.steps.some(s => s.node === 'render'));
        if (mode === 'bad-report') assert.equal(run.snapshot.outcome, 'rejected');
        else assert.equal(run.snapshot.status, 'failed');
        if (mode === 'timeout') assert.equal(app.driver.tasks.length, 0);
      }
    } finally { await app.release(run); }
    assert.equal(app.driver.live.size, 0); assert.deepEqual(await readdir(join(root, 'run/artifacts')), []);
    assert.deepEqual(await readdir(join(root, 'run/nodes')), []);
  });
