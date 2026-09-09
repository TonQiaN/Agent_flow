import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileWorkflow } from '@agentflow/engine';
import { createGradingFixture, gradingDefinition } from './flow.js';
import type { GradingOptions, GradingRun } from './flow.js';
import { sourcePaths } from './gate.js';
import type { GateReport } from './gate.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, options: GradingOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'af-tutor-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ...await createGradingFixture(root, options) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function report(f: Fixture, run: GradingRun, suffix = 'report'): Promise<GateReport> {
  const step = run.snapshot.steps.findLast(s => s.node === 'gate'); assert.ok(step); assert.equal(step.result.status, 'accepted');
  if (step.result.status !== 'accepted') throw new Error();
  const path = join(f.root, `${run.snapshot.runId}-${suffix}`); await f.files.materialize(step.result.output, run.snapshot.runId, path);
  return JSON.parse(await readFile(join(path, 'gate-report.json'), 'utf8')) as GateReport;
}
async function clean(f: Fixture, ...runs: GradingRun[]) {
  for (const run of runs) await f.release(run);
  assert.equal(f.driver.live.size, 0);
  for (const folder of ['artifacts', 'nodes', 'agents', 'transforms']) {
    try { assert.deepEqual(await readdir(join(f.root, folder)), []); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

test('Tutor: unordered multi-page answers pass after one user-selected repair; dry-run preserves original bytes', async t => {
  const f = await fixture(t), before = await Promise.all(sourcePaths.map(p => readFile(join(f.source, p), 'utf8'))), run = await f.run('repair');
  assert.equal(run.snapshot.status, 'succeeded'); assert.equal(run.snapshot.outcome, 'published');
  assert.deepEqual(run.snapshot.steps.map(s => s.node), ['intake', 'marker', 'gate', 'fixer', 'gate', 'projection', 'publish']);
  assert.deepEqual((await report(f, run)).findings, []); assert.equal((await report(f, run, 'again')).decision, 'passed');
  const output = run.snapshot.steps.find(s => s.node === 'projection')!.result;
  assert.equal(output.status, 'accepted'); if (output.status !== 'accepted') throw new Error();
  assert.equal((output.output as { total: number }).total, 5); assert.equal((output.output as { maxTotal: number }).maxTotal, 7);
  assert.equal(f.service.writes, 0); assert.equal(f.driver.tasks.length, 2); assert.match(f.driver.tasks[1]!.prompt, /gate-report/);
  assert.deepEqual(await Promise.all(sourcePaths.map(p => readFile(join(f.source, p), 'utf8'))), before);
  assert.ok(!JSON.stringify(run.snapshot).includes(f.root)); await clean(f, run);
});

test('Tutor: direct pass, idempotent apply, and changed source bytes conflict without a second service write', async t => {
  const f = await fixture(t, { marker: 'correct', mode: 'apply', allowApply: true });
  const first = await f.run('first'), second = await f.run('second');
  assert.equal(first.snapshot.steps.length, 5); assert.equal(first.snapshot.outcome, 'published');
  assert.equal(first.snapshot.lastAccepted?.result.status, 'accepted');
  if (first.snapshot.lastAccepted?.result.status !== 'accepted' || second.snapshot.lastAccepted?.result.status !== 'accepted') throw new Error();
  assert.equal((first.snapshot.lastAccepted.result.output as { status: string }).status, 'applied');
  assert.equal((second.snapshot.lastAccepted.result.output as { status: string }).status, 'already-applied');
  assert.equal(f.service.writes, 1); assert.equal((f.service.read('fixture-workout')!.value as { total: number }).total, 5);
  const path = join(f.source, 'source/key.json'); await writeFile(path, JSON.stringify(JSON.parse(await readFile(path, 'utf8')), null, 2));
  const changed = await f.run('changed'); assert.equal(changed.snapshot.status, 'failed');
  assert.equal((changed.snapshot.steps.at(-1)!.result as { code: string }).code, 'EFFECT_KEY_CONFLICT'); assert.equal(f.service.writes, 1);
  await clean(f, first, second, changed);
});

test('Tutor: Workflow controls repair target and budget; revision 999 cannot bypass the Gate', async t => {
  const f = await fixture(t);
  const zero = await f.run('zero', gradingDefinition({ repairs: 0 })); assert.equal(zero.snapshot.outcome, 'rejected'); assert.equal(zero.snapshot.steps.length, 3);
  const stuck = await f.run('stuck', gradingDefinition({ fixer: 'stuck', repairs: 2 }));
  assert.equal(stuck.snapshot.outcome, 'rejected'); assert.equal(stuck.snapshot.steps.filter(s => s.node === 'fixer').length, 2);
  assert.ok(stuck.snapshot.steps.filter(s => s.node === 'fixer').every(s => s.result.componentId === 'fixer-stuck'));
  assert.equal(stuck.snapshot.limits.length, 1); assert.equal((await report(f, stuck)).decision, 'revise');
  const bounded = await f.run('bounded', gradingDefinition({ maxSteps: 4 })); assert.equal(bounded.snapshot.status, 'exhausted'); assert.equal(bounded.snapshot.steps.length, 4);
  assert.equal(f.service.writes, 0); await clean(f, zero, stuck, bounded);
});

test('Tutor: malformed candidates fail the contract, altered sources reject, and bad page evidence requires repair', async t => {
  const f = await fixture(t, { mode: 'apply', allowApply: true });
  const malformed = await f.run('malformed', gradingDefinition({ marker: 'malformed' }));
  assert.equal(malformed.snapshot.status, 'failed'); assert.equal(malformed.snapshot.steps.length, 2); assert.ok(malformed.snapshot.steps.at(-1)?.result.status === 'failed');
  const tampered = await f.run('tampered', gradingDefinition({ marker: 'source-tamper' })); assert.equal(tampered.snapshot.outcome, 'rejected');
  assert.ok((await report(f, tampered)).findings.includes('SOURCE_CHANGED:source/key.json')); assert.equal(f.service.writes, 0);
  const evidence = await f.run('evidence', gradingDefinition({ marker: 'bad-evidence' })); assert.equal(evidence.snapshot.outcome, 'published');
  const firstGate = evidence.snapshot.steps.find(s => s.node === 'gate')!; assert.equal(firstGate.result.status, 'accepted');
  if (firstGate.result.status !== 'accepted') throw new Error(); assert.equal(firstGate.result.outcome, 'revise'); assert.equal(f.service.writes, 1);
  await clean(f, malformed, tampered, evidence);
});

test('Tutor: valid JSON alone cannot obtain a publish grant or bypass Gate provenance', async t => {
  const f = await fixture(t, { marker: 'correct', mode: 'apply', allowApply: true });
  const run = await f.run('good'); assert.equal(f.service.writes, 1);
  const projected = run.snapshot.steps.find(s => s.node === 'projection')!.result; if (projected.status !== 'accepted') throw new Error();
  const identity = { runId: 'good', nodeTaskId: 'forged-task', attemptId: 'attempt-1', attemptNumber: 1 };
  assert.equal(f.approve({ identity, componentId: 'publish', input: projected.output, target: 'fixture-workout', key: 'fixture-publication', mode: 'apply' }), undefined);
  const single = compileWorkflow({ id: 'bypass', start: 'publish', input: { kind: 'json', id: 'publication-json' }, outcomes: { done: { kind: 'json', id: 'effect-receipt' } }, maxSteps: 1,
    nodes: { publish: { component: 'publish' } }, routes: ['simulated', 'applied', 'already-applied'].map(outcome => ({ from: 'publish', outcome, to: { end: 'done' } })) }, f.catalog);
  const bypass = await f.runtime.start(single, 'bypass', projected.output).completion; assert.equal(bypass.status, 'failed'); assert.equal(f.service.writes, 1);
  // A freshly imported bundle may contain a perfectly valid passed report, but has no host Gate receipt.
  const gate = run.snapshot.steps.find(s => s.node === 'gate')!.result; if (gate.status !== 'accepted') throw new Error();
  const bundle = join(f.root, 'forged-source'); await f.files.materialize(gate.output, 'good', bundle);
  const forged = await f.files.prepareInput('forged', bundle, 'reviewed-files');
  const projection = f.bridge.resolve('publication-input');
  const rejected = await projection.executor.execute(projection.component, forged, { ...identity, runId: 'forged' }, { requested: () => false });
  assert.equal(rejected.status, 'failed'); await f.bridge.cleanup(rejected.identity); await f.files.release(forged, 'forged');
  await clean(f, run);
});

test('Tutor: apply requires host permission even with a genuine passing Gate', async t => {
  const f = await fixture(t, { marker: 'correct', mode: 'apply' }), run = await f.run('no-grant');
  assert.equal(run.snapshot.status, 'failed'); assert.equal((await report(f, run)).decision, 'passed'); assert.equal(f.service.writes, 0);
  await assert.rejects(f.run('no-grant'), /DUPLICATE_GRADING_RUN/); await clean(f, run);
});
