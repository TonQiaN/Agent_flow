import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractRegistry, FileContractRegistry, ScriptExecutor, WorkflowRuntime, compileWorkflow } from '@agentflow/engine';
import type { ExecutionBackend, ExecutionResource, WorkflowDefinition } from '@agentflow/engine';
import type { ComponentDefinition } from '@agentflow/domain';
import { DockerBackend, FileArtifactStore, FileScriptRecordReader, FileWorkflowCatalog, systemClock } from '@agentflow/integrations';

const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
const comp = (id: string, outcomes: Record<string, string> = { done: 'files' }): ComponentDefinition => ({ id, kind: 'transform', implementation: `${id}-impl`, inputContract: 'files', outcomes });
const workflow = (id: string): WorkflowDefinition => ({ id: 'scripts', start: 'first', maxSteps: 5,
  input: { kind: 'files', id: 'files' }, outcomes: { done: { kind: 'files', id: 'files' } },
  nodes: { first: { component: id } }, routes: [{ from: 'first', outcome: 'done', to: { end: 'done' } }] });
async function fixture(t: { after(fn: () => Promise<void>): void }, logBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'af-workflow-script-')), source = join(root, 'source');
  await mkdir(source); await writeFile(join(source, 'answer.json'), '{"revision":0}');
  const json = new ContractRegistry(); json.register('answer', { type: 'object', properties: { revision: { type: 'integer', minimum: 0 } }, required: ['revision'], additionalProperties: false });
  const contracts = new FileContractRegistry(json); contracts.register('files', { rules: [{ id: 'answer', kind: 'file', match: 'answer.json', minCount: 1, maxCount: 1,
    maxBytes: 1024, mediaTypes: ['application/json'], jsonContract: 'answer' }], maxFiles: 2, maxTotalBytes: 2048, unmatched: 'reject' });
  const store = new FileArtifactStore(join(root, 'store'), contracts), catalog = new FileWorkflowCatalog(contracts, store, join(root, 'nodes'));
  const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: process.env['AGENTFLOW_TEST_IMAGE'] ?? 'alpine:3', logBytes });
  const allocated: ExecutionResource[] = [];
  const tracked: ExecutionBackend = {
    async allocate() { const resource = await backend.allocate(); allocated.push(resource); return resource; },
    prepare: backend.prepare.bind(backend), create: backend.create.bind(backend), start: backend.start.bind(backend), observe: backend.observe.bind(backend),
    stop: backend.stop.bind(backend), capture: backend.capture.bind(backend), remove: backend.remove.bind(backend), release: backend.release.bind(backend),
  };
  t.after(async () => {
    for (const resource of allocated) {
      try { if (!(await backend.stop(resource)).confirmed) throw new Error('TEST_STOP_UNCONFIRMED'); await backend.remove(resource); await backend.release(resource); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'UNKNOWN_OWNED_RESOURCE') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const executor = new ScriptExecutor(tracked, systemClock, new FileScriptRecordReader());
  return { root, source, catalog, executor, backend, tracked };
}

test('Workflow: real Docker script and file Gate preserve outcomes, source provenance and writable isolation', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.catalog.registerScript(comp('script', { accepted: 'files', rejected: 'files' }), f.executor, { timeoutMs: 15000, argv: ['/bin/sh', '-c', `set -eu
test "$PWD" = /task/work
printf '{"revision":1}' > /task/input/answer.json
cp /task/input/answer.json /task/outputs/answer.json
printf 'script log' >&2
printf '{"schema":"agentflow-script-result/v1","outcome":"accepted"}'`] });
  f.catalog.registerFunction({ ...comp('gate'), kind: 'gate' }, async ctx => {
    const text = await readFile(join(ctx.inputPath, 'answer.json'), 'utf8'); assert.deepEqual(JSON.parse(text), { revision: 1 });
    await writeFile(join(ctx.outputsPath, 'answer.json'), text); return { outcome: 'done' };
  });
  const plan = compileWorkflow({ ...workflow('script'), nodes: { first: { component: 'script' }, gate: { component: 'gate' } },
    outcomes: { done: { kind: 'files', id: 'files' }, rejected: { kind: 'files', id: 'files' } }, routes: [
      { from: 'first', outcome: 'accepted', to: { node: 'gate' } }, { from: 'first', outcome: 'rejected', to: { end: 'rejected' } }, { from: 'gate', outcome: 'done', to: { end: 'done' } }] }, f.catalog);
  const input = await f.catalog.prepareInput('run', f.source, 'files'), result = await new WorkflowRuntime().start(plan, 'run', input).completion;
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(result.steps.length, 2);
  const first = result.steps[0]!.result, last = result.steps[1]!.result;
  if (first.status !== 'accepted' || last.status !== 'accepted') throw new Error();
  const evidence = f.catalog.inspect(first.output, 'run').receipt!;
  assert.equal(evidence.script!.outcome, 'accepted'); assert.equal(evidence.script!.exitCode, 0); assert.match(evidence.script!.imageId!, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.predecessor, input); assert.deepEqual(f.catalog.inspect(last.output, 'run').receipt!.predecessor, first.output);
  assert.ok(!JSON.stringify(evidence).includes(f.root)); assert.equal(await readFile(join(f.source, 'answer.json'), 'utf8'), '{"revision":0}');
  await f.catalog.materialize(last.output, 'run', join(f.root, 'final')); assert.equal(await readFile(join(f.root, 'final/answer.json'), 'utf8'), '{"revision":1}');
  for (const ref of [input, first.output, last.output]) await f.catalog.release(ref, 'run');
  for (const name of ['attempts', 'nodes', 'store']) assert.deepEqual(await readdir(join(f.root, name)), []);
});

test('Workflow: real scripts reject logs, wrong outcomes, invalid bytes, nonzero exits and invalid output files', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const good = `printf '{"schema":"agentflow-script-result/v1","outcome":"done"}'`;
  const cases = [
    { id: 'logs', body: `echo log; ${good}`, code: 'INVALID_SCRIPT_RESULT' },
    { id: 'outcome', body: `printf '{"schema":"agentflow-script-result/v1","outcome":"other"}'`, code: 'INVALID_SCRIPT_RESULT' },
    { id: 'utf8', body: `printf '\\377'`, code: 'INVALID_SCRIPT_RESULT' },
    { id: 'nonzero', body: `${good}; exit 7`, code: 'SCRIPT_EXECUTION_FAILED' },
    { id: 'contract', body: `rm /task/outputs/answer.json; ${good}`, code: 'OUTPUT_CONTRACT_FAILED' },
    { id: 'large', body: 'head -c 70000 /dev/zero', code: 'SCRIPT_CAPTURE_INCOMPLETE' },
  ];
  for (const c of cases) {
    f.catalog.registerScript(comp(c.id), f.executor, { argv: ['/bin/sh', '-c', `cp /task/input/answer.json /task/outputs/answer.json; ${c.body}`], timeoutMs: 15000 });
    const input = await f.catalog.prepareInput(c.id, f.source, 'files'), result = await new WorkflowRuntime().start(compileWorkflow(workflow(c.id), f.catalog), c.id, input).completion;
    assert.equal(result.status, 'failed', c.id); assert.equal(result.reason, c.code, JSON.stringify(result)); assert.equal(result.lastAccepted, null);
    await f.catalog.cleanup(result.currentIdentity!); await f.catalog.release(input, c.id);
  }
  assert.deepEqual(await readdir(join(f.root, 'attempts')), []);
});

test('Workflow: real script cancellation waits for termination and blocks its successor; timeout is failure', { skip: !enabled, timeout: 60000 }, async t => {
  const f = await fixture(t); let started!: () => void;
  const reachedStart = new Promise<void>(resolve => { started = resolve; });
  const original = f.tracked.start; f.tracked.start = async resource => { await original(resource); started(); };
  let nextCalls = 0;
  f.catalog.registerScript(comp('slow'), f.executor, { argv: ['/bin/sh', '-c', 'sleep 30'], timeoutMs: 15000 });
  f.catalog.registerFunction(comp('next'), async () => { nextCalls++; return { outcome: 'done' }; });
  const plan = compileWorkflow({ ...workflow('slow'), nodes: { first: { component: 'slow' }, next: { component: 'next' } }, routes: [
    { from: 'first', outcome: 'done', to: { node: 'next' } }, { from: 'next', outcome: 'done', to: { end: 'done' } }] }, f.catalog);
  const input = await f.catalog.prepareInput('cancel', f.source, 'files'), run = new WorkflowRuntime().start(plan, 'cancel', input);
  await reachedStart; run.cancel(); const result = await run.completion;
  assert.equal(result.status, 'cancelled'); assert.equal(nextCalls, 0);
  await f.catalog.cleanup({ runId: 'cancel', nodeTaskId: 'task-1', attemptId: 'attempt-1', attemptNumber: 1 }); await f.catalog.release(input, 'cancel');
  f.catalog.registerScript(comp('timeout'), f.executor, { argv: ['/bin/sh', '-c', 'sleep 30'], timeoutMs: 700 });
  const timeoutInput = await f.catalog.prepareInput('timeout', f.source, 'files');
  const timed = await new WorkflowRuntime().start(compileWorkflow(workflow('timeout'), f.catalog), 'timeout', timeoutInput).completion;
  assert.equal(timed.status, 'failed'); assert.equal(timed.reason, 'SCRIPT_EXECUTION_FAILED');
  await f.catalog.cleanup(timed.currentIdentity!); await f.catalog.release(timeoutInput, 'timeout');
  assert.deepEqual(await readdir(join(f.root, 'attempts')), []);
});
