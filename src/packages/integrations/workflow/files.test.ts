import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComponentDefinition, JsonValue } from '@agentflow/domain';
import { AgentExecutor, ContractRegistry, FileContractRegistry, compileWorkflow, WorkflowRuntime } from '@agentflow/engine';
import type { AgentExecutionDriver, AgentExecutionFacts, ArtifactStore, HarnessTask, WorkflowDefinition } from '@agentflow/engine';
import { FileArtifactStore } from '../artifacts/file-store.js';
import { FileArtifactArchive } from '../artifacts/file-archive.js';
import { FileWorkflowCatalog } from './files.js';

const identity = { runId: 'run', nodeTaskId: 'task-1', attemptId: 'attempt-1', attemptNumber: 1 };
const component = (id: string, kind: ComponentDefinition['kind'] = 'transform'): ComponentDefinition => ({ id, kind, implementation: `${id}-impl`, inputContract: 'files', outcomes: { done: 'files' } });
const one = (id = 'transform'): WorkflowDefinition => ({ id: 'flow', start: 'first', input: { kind: 'files', id: 'files' }, outcomes: { done: { kind: 'files', id: 'files' } },
  maxSteps: 3, nodes: { first: { component: id } }, routes: [{ from: 'first', outcome: 'done', to: { end: 'done' } }] });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-file-workflow-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'answer.json'), '{"revision":0}');
  const json = new ContractRegistry(); json.register('answer', { type: 'object', properties: { revision: { type: 'integer', minimum: 0 } }, required: ['revision'], additionalProperties: false });
  const contracts = new FileContractRegistry(json); contracts.register('files', { rules: [{ id: 'answer', kind: 'file', match: 'answer.json', minCount: 1, maxCount: 1,
    maxBytes: 2048, mediaTypes: ['application/json'], jsonContract: 'answer' }], maxFiles: 2, maxTotalBytes: 4096, unmatched: 'reject' });
  const store = new FileArtifactStore(join(root, 'store'), contracts);
  const catalog = new FileWorkflowCatalog(contracts, store, join(root, 'nodes'));
  return { root, source, contracts, store, catalog };
}
function goodFacts(task: HarnessTask, outputsPath: string): AgentExecutionFacts {
  return { runner: { identity: task.identity, resource: { id: 'fixture-resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
    capture: { imageId: null, outputsPath, files: {}, stdout: { path: '/fixture/raw', bytes: 1, complete: true, truncated: false },
      stderr: { path: '/fixture/errors', bytes: 0, complete: true, truncated: false } }, diagnostics: [], startedAt: 0, finishedAt: 1 },
    harness: { identity: task.identity, harness: 'fixture', status: 'completed', outcome: null, events: [], diagnostics: [],
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }, version: '1.0.0', finalized: true, diagnostics: [] };
}
function driver(root: string, store: ArtifactStore, change: (facts: AgentExecutionFacts) => AgentExecutionFacts = f => f) {
  let runs = 0, releases = 0, failRelease = false;
  const tasks: HarnessTask[] = [];
  const impl: AgentExecutionDriver = { harness: 'fixture', validate(task) { if (!task.prompt || (task.config as { invalid?: boolean }).invalid) throw new Error('PRIVATE_CONFIG'); },
    async run(task, input) {
      runs++; tasks.push(structuredClone(task)); const own = await mkdtemp(join(root, 'driver-'));
      await store.materialize(input.id, join(own, 'input')); await mkdir(join(own, 'outputs'));
      const answer = JSON.parse(await readFile(join(own, 'input/answer.json'), 'utf8')) as { revision: number };
      await writeFile(join(own, 'input/answer.json'), '{"revision":999}');
      await writeFile(join(own, 'outputs/answer.json'), JSON.stringify({ revision: answer.revision + 1 }));
      let facts = change(goodFacts(task, join(own, 'outputs')));
      return { get facts() { return facts; }, async retryCleanup() { facts = goodFacts(task, join(own, 'outputs')); },
        async release() { if (failRelease) throw new Error('PRIVATE_CLEANUP'); releases++; await rm(own, { recursive: true, force: true }); } };
    } };
  return { impl, tasks, runs: () => runs, releases: () => releases, failRelease: (v: boolean) => { failRelease = v; } };
}

test('file Workflow crosses Agent/Gate/Fixer with private provenance, writable copies and explicit releases', async t => {
  const f = await fixture(t), d = driver(f.root, f.store), agents = new AgentExecutor(f.contracts, f.store, d.impl);
  const task = { prompt: 'User defined marking instruction', config: {} };
  f.catalog.registerAgent(component('marker', 'agent'), agents, task); f.catalog.registerAgent(component('fixer', 'agent'), agents, task);
  const gate = { ...component('gate', 'gate'), outcomes: { accepted: 'files', revise: 'files' } };
  f.catalog.registerFunction(gate, async ctx => {
    const text = await readFile(join(ctx.inputPath, 'answer.json'), 'utf8'), answer = JSON.parse(text) as { revision: number };
    await writeFile(join(ctx.inputPath, 'answer.json'), '{"revision":999}'); await writeFile(join(ctx.outputsPath, 'answer.json'), text);
    return { outcome: answer.revision >= 2 ? 'accepted' : 'revise' };
  });
  const plan = compileWorkflow({ ...one('marker'), maxSteps: 8, nodes: { first: { component: 'marker' }, review: { component: 'gate' }, fix: { component: 'fixer' } },
    outcomes: { accepted: { kind: 'files', id: 'files' }, rejected: { kind: 'files', id: 'files' } }, routes: [
      { from: 'first', outcome: 'done', to: { node: 'review' } }, { from: 'review', outcome: 'accepted', to: { end: 'accepted' } },
      { from: 'review', outcome: 'revise', to: { node: 'fix' }, limit: { max: 1, exhausted: { end: 'rejected' } } }, { from: 'fix', outcome: 'done', to: { node: 'review' } }] }, f.catalog);
  task.prompt = 'mutated';
  const input = await f.catalog.prepareInput('run', f.source, 'files'), result = await new WorkflowRuntime().start(plan, 'run', input).completion;
  assert.equal(result.status, 'succeeded'); assert.equal(result.outcome, 'accepted'); assert.equal(result.steps.length, 4);
  const refs: JsonValue[] = [input]; let previous = input;
  for (const step of result.steps) {
    assert.equal(step.result.status, 'accepted'); if (step.result.status !== 'accepted') throw new Error();
    const output = step.result.output, record = f.catalog.inspect(output, 'run'); assert.ok(record.receipt);
    assert.deepEqual(record.receipt.predecessor, previous); assert.deepEqual(record.receipt.input, f.catalog.inspect(previous, 'run').manifest);
    assert.deepEqual(record.receipt.identity, step.result.identity);
    if (record.receipt.agent) {
      assert.equal(record.receipt.agent.predecessor, null); assert.equal(record.receipt.agent.input.id, record.receipt.input.id);
      assert.deepEqual(record.receipt.agent.input.files, record.receipt.input.files);
    }
    (record.manifest.files[0] as { sha256: string }).sha256 = 'forged';
    assert.notEqual(f.catalog.inspect(output, 'run').manifest.files[0]!.sha256, 'forged');
    refs.push(output); previous = output;
  }
  await f.catalog.materialize(previous, 'run', join(f.root, 'final'));
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'final/answer.json'), 'utf8')), { revision: 2 });
  assert.equal(await readFile(join(f.source, 'answer.json'), 'utf8'), '{"revision":0}');
  assert.equal(d.runs(), 2); assert.equal(d.releases(), 2); assert.ok(d.tasks.every(t => t.prompt === 'User defined marking instruction'));
  assert.deepEqual(await readdir(join(f.root, 'nodes')), []); assert.ok(!JSON.stringify(result).includes(f.root));
  for (const ref of refs) await f.catalog.release(ref, 'run');
  assert.deepEqual(await readdir(join(f.root, 'store')), []); assert.equal(f.catalog.inspect(previous, 'run').released, true);
  await assert.rejects(f.catalog.materialize(previous, 'run', join(f.root, 'after-release')), /UNAVAILABLE_WORKFLOW_FILES/);
});

test('forged, cross-Run, other-catalog, released and wrong-contract references cannot execute', async t => {
  const f = await fixture(t); let calls = 0;
  f.catalog.registerFunction(component('transform'), async () => { calls++; return { outcome: 'done' }; });
  const plan = compileWorkflow(one(), f.catalog), input = await f.catalog.prepareInput('run', f.source, 'files');
  const other = new FileWorkflowCatalog(f.contracts, f.store, join(f.root, 'other'));
  const foreign = await other.prepareInput('run', f.source, 'files');
  f.contracts.register('other-files', f.contracts.definition('files'));
  const wrongContract = await f.catalog.prepareInput('run', f.source, 'other-files');
  for (const value of [{ fileRef: 'invented' }, f.catalog.inspect(input, 'run').manifest as unknown as JsonValue, foreign, wrongContract]) {
    assert.equal((await new WorkflowRuntime().start(plan, 'run', value).completion).status, 'failed');
  }
  assert.equal((await new WorkflowRuntime().start(plan, 'other-run', input).completion).status, 'failed');
  assert.ok(f.catalog.check('missing-contract', input).length);
  await f.catalog.release(input, 'run');
  assert.equal((await new WorkflowRuntime().start(plan, 'run', input).completion).status, 'failed'); assert.equal(calls, 0);
});

test('tampered snapshot fails handoff before any function invocation', async t => {
  const f = await fixture(t); let calls = 0;
  f.catalog.registerFunction(component('transform'), async () => { calls++; return { outcome: 'done' }; });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  await writeFile(join(f.root, 'store', (await readdir(join(f.root, 'store')))[0]!, 'answer.json'), '{"revision":8}');
  const result = await new WorkflowRuntime().start(compileWorkflow(one(), f.catalog), 'run', input).completion;
  assert.equal(result.status, 'failed'); assert.equal(calls, 0); assert.equal(result.issues[0]!.code, 'ARTIFACT_INTEGRITY_MISMATCH');
  await f.catalog.cleanup(identity); assert.deepEqual(await readdir(join(f.root, 'nodes')), []);
});

test('invalid file outcome, schema output and arbitrary function exceptions never route or expose text', async t => {
  for (const mode of ['outcome', 'schema', 'throw']) {
    const f = await fixture(t);
    f.catalog.registerFunction(component('transform'), async ctx => {
      if (mode === 'throw') throw new Error('PRIVATE_CONTENT');
      await writeFile(join(ctx.outputsPath, 'answer.json'), mode === 'schema' ? '{"revision":-1}' : '{"revision":1}');
      return { outcome: mode === 'outcome' ? 'unknown' : 'done' };
    });
    const input = await f.catalog.prepareInput('run', f.source, 'files');
    const result = await new WorkflowRuntime().start(compileWorkflow(one(), f.catalog), 'run', input).completion;
    assert.equal(result.status, 'failed'); assert.equal(result.lastAccepted, null); assert.ok(!JSON.stringify(result).includes('PRIVATE_CONTENT'));
    if (mode === 'schema') assert.deepEqual(result.issues, [{ contractId: 'files', path: 'answer.json', rule: 'answer', code: 'JSON_CONTRACT' }]);
    await f.catalog.cleanup(identity); assert.deepEqual(await readdir(join(f.root, 'nodes')), []);
  }
});

test('active input cannot be released or cleaned; cancelling waits for trusted function completion', async t => {
  const f = await fixture(t); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), finishing = new Promise<void>(r => { finish = r; });
  f.catalog.registerFunction(component('transform'), async ctx => { enter(); await finishing;
    await writeFile(join(ctx.outputsPath, 'answer.json'), await readFile(join(ctx.inputPath, 'answer.json'))); return { outcome: 'done' }; });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const run = new WorkflowRuntime().start(compileWorkflow(one(), f.catalog), 'run', input); await entered;
  await assert.rejects(f.catalog.release(input, 'run'), /WORKFLOW_FILES_IN_USE/);
  await assert.rejects(f.catalog.cleanup(identity), /INVALID_WORKFLOW_CLEANUP/);
  run.cancel(); assert.equal(run.query().status, 'cancelling'); finish();
  const result = await run.completion; assert.equal(result.status, 'cancelled'); assert.equal(result.steps.length, 1);
  assert.deepEqual(await readdir(join(f.root, 'nodes')), []);
});

test('Agent cleanup failure blocks acceptance and retains a retry without upgrading the failed run', async t => {
  const f = await fixture(t), d = driver(f.root, f.store); d.failRelease(true);
  f.catalog.registerAgent(component('agent', 'agent'), new AgentExecutor(f.contracts, f.store, d.impl), { prompt: 'user task', config: {} });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const run = new WorkflowRuntime().start(compileWorkflow(one('agent'), f.catalog), 'run', input), result = await run.completion;
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'FILE_NODE_CLEANUP_FAILED'); assert.equal(result.lastAccepted, null);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CLEANUP')); await assert.rejects(readdir(join(f.root, 'nodes')), { code: 'ENOENT' });
  await assert.rejects(f.catalog.cleanup(identity)); d.failRelease(false); await f.catalog.cleanup(identity);
  await assert.rejects(readdir(join(f.root, 'nodes')), { code: 'ENOENT' }); assert.equal((await readdir(join(f.root, 'store'))).length, 1);
  assert.equal(run.query().status, 'failed'); await f.catalog.release(input, 'run');
});

test('unconfirmed Agent stop retains input and does not claim cancellation; recovery only cleans resources', async t => {
  let cancel = (): void => {};
  const f = await fixture(t), d = driver(f.root, f.store, facts => { cancel(); return { ...facts, runner: { ...facts.runner, stop: 'unknown', cleanup: 'blocked' }, finalized: false }; });
  f.catalog.registerAgent(component('agent', 'agent'), new AgentExecutor(f.contracts, f.store, d.impl), { prompt: 'user task', config: {} });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const run = new WorkflowRuntime().start(compileWorkflow(one('agent'), f.catalog), 'run', input); cancel = () => { run.cancel(); };
  const result = await run.completion; assert.equal(result.cancelRequested, true);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'EXECUTION_STOP_UNCONFIRMED'); assert.deepEqual(result.currentIdentity, identity);
  await assert.rejects(readdir(join(f.root, 'nodes')), { code: 'ENOENT' });
  await assert.rejects(f.catalog.release(input, 'run'), /WORKFLOW_FILES_IN_USE/);
  await f.catalog.materialize(input, 'run', join(f.root, 'retained'));
  assert.equal(await readFile(join(f.root, 'retained/answer.json'), 'utf8'), '{"revision":0}'); assert.equal(d.releases(), 0);
  await f.catalog.cleanup(identity); assert.equal(d.releases(), 1); assert.equal(run.query().reason, 'EXECUTION_STOP_UNCONFIRMED'); await f.catalog.release(input, 'run');
});

test('invalid Agent configuration fails registration without capture or execution, and duplicate attempts stay reserved', async t => {
  const f = await fixture(t), d = driver(f.root, f.store), executor = new AgentExecutor(f.contracts, f.store, d.impl);
  assert.throws(() => f.catalog.registerAgent(component('bad', 'agent'), executor, { prompt: 'task', config: { invalid: true } }), /INVALID_AGENT_CONFIGURATION/);
  assert.equal(d.runs(), 0); await assert.rejects(stat(join(f.root, 'store')), { code: 'ENOENT' });
  f.catalog.registerFunction(component('transform'), async () => ({ outcome: 'unknown' }));
  const input = await f.catalog.prepareInput('run', f.source, 'files'), cancellation = { requested: () => false };
  await f.catalog.execute(component('transform'), input, identity, cancellation);
  await assert.rejects(f.catalog.execute(component('transform'), input, { ...identity, attemptNumber: 2 }, cancellation), /INVALID_FILE_WORKFLOW_ATTEMPT/);
  await f.catalog.cleanup(identity);
});

test('Agent source recapture must agree with the trusted Workflow predecessor', async t => {
  const f = await fixture(t), other = join(f.root, 'other-input'); await mkdir(other); await writeFile(join(other, 'answer.json'), '{"revision":7}');
  const swapped: ArtifactStore = { capture: (source, id) => f.store.capture(source.endsWith('/input') ? other : source, id),
    materialize: (id, destination) => f.store.materialize(id, destination), release: id => f.store.release(id) };
  const d = driver(f.root, f.store);
  f.catalog.registerAgent(component('agent', 'agent'), new AgentExecutor(f.contracts, swapped, d.impl), { prompt: 'task', config: {} });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const result = await new WorkflowRuntime().start(compileWorkflow(one('agent'), f.catalog), 'run', input).completion;
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'WORKFLOW_AGENT_INPUT_MISMATCH'); assert.equal(result.lastAccepted, null);
  await f.catalog.cleanup(identity); assert.equal((await readdir(join(f.root, 'store'))).length, 1);
});

test('an insecure existing work root is refused before private input is materialized', async t => {
  const f = await fixture(t); let calls = 0;
  await mkdir(join(f.root, 'nodes')); await chmod(join(f.root, 'nodes'), 0o755);
  f.catalog.registerFunction(component('transform'), async () => { calls++; return { outcome: 'done' }; });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const result = await new WorkflowRuntime().start(compileWorkflow(one(), f.catalog), 'run', input).completion;
  assert.equal(result.status, 'failed'); assert.equal(calls, 0); assert.equal(result.issues[0]!.code, 'INVALID_WORKFLOW_WORK_ROOT');
  assert.deepEqual(await readdir(join(f.root, 'nodes')), []); await f.catalog.cleanup(identity);
});

test('driver start exceptions without stop evidence retain the borrowed input and cannot be cleaned optimistically', async t => {
  const f = await fixture(t);
  const bad: AgentExecutionDriver = { harness: 'fixture', validate() {}, async run() { throw new Error('PRIVATE_START_ERROR'); } };
  f.catalog.registerAgent(component('agent', 'agent'), new AgentExecutor(f.contracts, f.store, bad), { prompt: 'task', config: {} });
  const input = await f.catalog.prepareInput('run', f.source, 'files');
  const result = await new WorkflowRuntime().start(compileWorkflow(one('agent'), f.catalog), 'run', input).completion;
  assert.equal(result.reason, 'EXECUTION_STOP_UNCONFIRMED'); assert.ok(!JSON.stringify(result).includes('PRIVATE_START_ERROR'));
  await assert.rejects(f.catalog.cleanup(identity), /EXECUTION_STOP_UNCONFIRMED/);
  await assert.rejects(f.catalog.release(input, 'run'), /WORKFLOW_FILES_IN_USE/);
  await assert.rejects(readdir(join(f.root, 'nodes')), { code: 'ENOENT' });
});

test('direct execution snapshots caller component and identity across asynchronous file work', async t => {
  const f = await fixture(t); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), finishing = new Promise<void>(r => { finish = r; });
  f.catalog.registerFunction(component('transform'), async ctx => {
    enter(); await finishing; (ctx.identity as { runId: string }).runId = 'function-forged';
    await writeFile(join(ctx.outputsPath, 'answer.json'), '{"revision":1}'); return { outcome: 'done' };
  });
  const input = await f.catalog.prepareInput('run', f.source, 'files'), c = structuredClone(component('transform')), i = { ...identity };
  const attempt = f.catalog.execute(c, input, i, { requested: () => false }); await entered;
  (c as { id: string }).id = 'caller-forged'; (c.outcomes as Record<string, string>)['done'] = 'unknown'; i.runId = 'other'; finish();
  const result = await attempt; assert.equal(result.status, 'accepted'); assert.deepEqual(result.identity, identity); assert.equal(result.componentId, 'transform');
  if (result.status !== 'accepted') throw new Error();
  assert.deepEqual(f.catalog.inspect(result.output, 'run').receipt!.identity, identity);
  await f.catalog.release(result.output, 'run'); await f.catalog.release(input, 'run');
  assert.deepEqual(await readdir(join(f.root, 'nodes')), []); assert.deepEqual(await readdir(join(f.root, 'store')), []);
});

test('Agent Catalog reuses only its shared store and preserves file handoff for different stores', async t => {
  for (const shared of [true, false]) {
    const f = await fixture(t), target = shared ? f.store : new FileArtifactStore(join(f.root, 'agent-store'), f.contracts);
    let captures = 0; const capture = target.capture.bind(target); target.capture = async (...args) => { captures++; return capture(...args); };
    const d = driver(f.root, target), agent = new AgentExecutor(f.contracts, target, d.impl), c = component('agent', 'agent');
    f.catalog.registerAgent(c, agent, { prompt: 'mark', config: {} });
    const input = await f.catalog.prepareInput('run', f.source, 'files'); captures = 0;
    const result = await f.catalog.execute(c, input, identity, { requested: () => false });
    assert.equal(result.status, 'accepted'); assert.equal(captures, shared ? 1 : 2);
    if (result.status !== 'accepted') throw new Error();
    if (shared) await assert.rejects(readdir(join(f.root, 'nodes')), { code: 'ENOENT' });
    else assert.deepEqual(await readdir(join(f.root, 'nodes')), []);
    await f.catalog.materialize(input, 'run', join(f.root, 'input-still-owned'));
    assert.equal(await readFile(join(f.root, 'input-still-owned/answer.json'), 'utf8'), '{"revision":0}');
    await f.catalog.release(result.output, 'run'); await f.catalog.release(input, 'run');
    assert.deepEqual(await readdir(f.store.root), []);
    if (!shared) assert.deepEqual(await readdir(target.root), []);
  }
});


test('checkpoint transfer skips Catalog staging with the new port and retains old archive fallback', async t => {
  for (const direct of [true, false]) {
    const f = await fixture(t), archive = new FileArtifactArchive(join(f.root, 'archive'), f.contracts);
    const installed = direct ? archive : { capture: archive.capture.bind(archive), read: archive.read.bind(archive), materialize: archive.materialize.bind(archive) };
    const work = join(f.root, 'checkpoint-work'), catalog = new FileWorkflowCatalog(f.contracts, f.store, work, installed);
    const input = await catalog.prepareInput('run', f.source, 'files');
    const saved = await catalog.checkpointValue(input, 'run', 'files') as any;
    assert.deepEqual(saved.manifest.files, (await archive.read(saved.archive)).files);
    if (direct) await assert.rejects(readdir(work), { code: 'ENOENT' }); else assert.deepEqual(await readdir(work), []);
    await catalog.release(input, 'run'); assert.deepEqual(await readdir(f.store.root), []);
    await archive.materialize(saved.archive, join(f.root, 'after-release'));
    assert.equal(await readFile(join(f.root, 'after-release/answer.json'), 'utf8'), '{"revision":0}');
  }
});
