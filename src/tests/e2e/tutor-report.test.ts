import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

for (const mode of ['confirmed', 'absent', 'wrong-hash', 'tampered-projection'] as const) test(`installed Tutor missing response projection ${mode}`,
  { skip: !workspace || !python, timeout: 120000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'af-tutor-completeness-')); t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'bundle');
    await promisify(execFile)(python!, [fixtureProgram, 'source', '--workspace', workspace!, '--output', source], { timeout: 30000 });
    // Change a synthetic fixture to a legitimately unresolved item; keep its reviewed inputs self-consistent.
    await promisify(execFile)(python!, ['-c', `import json,hashlib,sys
from pathlib import Path
root=Path(sys.argv[1])
def write(path,value):path.write_text(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False))
m_path=root/'candidate/submission-mapping.json'; m=json.loads(m_path.read_text())
for item in m['item_mappings']:item.update(mapping_status='MISSING',regions=[])
m['presentation_order']['ordered_pages']=[]
m['presentation_order']['unplaced_page_ids']=[p['exam_submission_page_id'] for p in m['pages']]
write(m_path,m)
p=root/'candidate/marking-candidate.json'; c=json.loads(p.read_text()); c['raw_score']=None
c['submission_mapping_sha256']=hashlib.sha256(m_path.read_bytes()).hexdigest()
for item in c['item_results']:
 item.update(response_status='MISSING',awarded_marks=None,evidence_regions=[],annotation_intents=[])
 item['criterion_results'].update(selected_path_id=None,criteria=[],rules_applied=[])
write(p,c)`, source]);
    const candidatePath = join(source, 'candidate/marking-candidate.json'), before = await readFile(candidatePath), candidate = JSON.parse(before.toString());
    const confirmation = { schema_version: 1 as const, job_id: fixtureContext.reportId,
      candidate_sha256: mode === 'wrong-hash' ? '0'.repeat(64) : createHash('sha256').update(before).digest('hex'),
      confirmed_at: '2026-09-10T09:00:00Z', confirmation_text: 'Synthetic explicit complete-submission confirmation.', submission_complete: true as const,
      missing_item_ids: candidate.item_results.map((item: { assessable_item: { id: string } }) => item.assessable_item.id) };
    class Driver extends TutorReportFixtureDriver {
      override async run(...args: Parameters<TutorReportFixtureDriver['run']>) {
        const handle = await super.run(...args);
        if (mode === 'tampered-projection') await writeFile(join(handle.facts.runner.capture!.outputsPath, 'report-source/input/report-marking-projection.json'), '{}');
        return handle;
      }
    }
    const app = await createTutorReportApplication(join(root, 'run'), { tutorWorkspace: workspace!, python: python!, source, context: fixtureContext,
      ...(mode === 'absent' ? {} : { submissionCompleteness: confirmation }),
      reporter: { id: 'reporter', prompt: 'Explicit synthetic fixture.', config: { mode: 'correct' } },
      driver: store => new Driver(store, join(root, 'agent'), workspace!, python!) });
    // Setup captures configuration: later caller mutation must not authorize another candidate.
    confirmation.candidate_sha256 = 'f'.repeat(64);
    const run = await app.run('complete-submission-test');
    try {
      assert.deepEqual(await readFile(candidatePath), before);
      if (mode === 'confirmed') {
        assert.equal(run.snapshot.outcome, 'completed', JSON.stringify(run.snapshot));
        const last = run.snapshot.lastAccepted!.result; assert.equal(last.status, 'accepted');
        if (last.status !== 'accepted') throw new Error('TEST_RESULT_REQUIRED');
        await app.files.materialize(last.output, run.snapshot.runId, join(root, 'accepted'));
        assert.deepEqual(await readFile(join(root, 'accepted/candidate/marking-candidate.json')), before);
        const projection = JSON.parse(await readFile(join(root, 'accepted/report-source/input/report-marking-projection.json'), 'utf8'));
        assert.equal(projection.raw_score, 0); assert.equal(projection.item_results[0].response_status, 'MISSING');
        assert.equal(projection.item_results[0].awarded_marks, 0); assert.deepEqual(projection.item_results[0].evidence_regions, []);
        assert.equal((await readFile(join(root, 'accepted/report.pdf'))).subarray(0, 5).toString(), '%PDF-');
      } else {
        assert.equal(run.snapshot.status, 'failed'); assert.ok(!run.snapshot.steps.some(step => step.node === 'render'));
        assert.equal(app.driver.tasks.length, mode === 'tampered-projection' ? 1 : 0);
      }
    } finally { await app.release(run); }
    assert.equal(app.driver.live.size, 0); assert.deepEqual(await readdir(join(root, 'run/artifacts')), []);
  });
