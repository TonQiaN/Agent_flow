import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@agentflow/domain';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import type { WorkflowCheckpoint } from './checkpoint.js';
import type { WorkflowNodeExecutor, WorkflowDefinition } from './types.js';
import type { RunRecordStore, RunRecord } from '../persistence/types.js';

const flow: WorkflowDefinition = { id: 'checkpoints', start: 'a', input: { kind: 'json', id: 'json' }, maxSteps: 5,
  nodes: { a: { component: 'a' }, b: { component: 'b' } }, outcomes: { done: { kind: 'json', id: 'json' } },
  routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function setup(execute: WorkflowNodeExecutor['execute'], definition = flow) {
  const executor: WorkflowNodeExecutor = { validate() {}, contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: true }),
    executionDefinition: async () => ({ schema: 'test-json-execution/v1' }), check: () => [], execute };
  const compiled = compileWorkflow(definition, { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'json', outcomes: { ok: 'json' } }, executor }) });
  return { executor, compiled };
}
class Store implements RunRecordStore {
  records: RunRecord[] = [];
  hook?: (content: WorkflowCheckpoint) => Promise<void>;
  async create(runId: string, content: JsonValue): Promise<RunRecord> {
    assert.equal(this.records.length, 0); const r = { runId, revision: 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r);
  }
  async read(): Promise<RunRecord | null> { return structuredClone(this.records.at(-1) ?? null); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue): Promise<RunRecord> {
    await this.hook?.(content as unknown as WorkflowCheckpoint);
    assert.equal(this.records.at(-1)!.revision, revision);
    const r = { runId, revision: revision + 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r);
  }
  latest(): WorkflowCheckpoint { return structuredClone(this.records.at(-1)!.content) as unknown as WorkflowCheckpoint; }
}

test('normal Workflow checkpoints precede calls and atomically bind accepted output, route and successor', async () => {
  const store = new Store(), calls: string[] = [];
  const { compiled } = setup(async (c, input, identity) => {
    const checkpoint = store.latest(); calls.push(c.id);
    assert.equal(checkpoint.snapshot.currentNode, c.id); assert.deepEqual(checkpoint.snapshot.currentIdentity, identity);
    assert.equal(checkpoint.snapshot.steps.length, c.id === 'a' ? 0 : 1);
    if (c.id === 'b') assert.deepEqual(checkpoint.values[1]!.saved, { schema: 'agentflow-json-value/v1', value: 1 });
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: (input as number) + 1 };
  });
  const handle = await new WorkflowRuntime().startPersisted(compiled, 'run', 0, store);
  assert.equal((await handle.completion).status, 'succeeded'); assert.deepEqual(calls, ['a', 'b']);
  assert.equal(store.records.length, 5);
  const committed = store.records[2]!.content as unknown as WorkflowCheckpoint;
  assert.equal(committed.snapshot.steps.length, 1); assert.equal(committed.cursor.node, 'b'); assert.equal(committed.snapshot.currentIdentity, null);
  assert.deepEqual(committed.cursor.traversals, { '["a","ok"]': 1 }); assert.equal(committed.cursor.value, 1);
  const saved = store.latest(); assert.equal(saved.values.length, 3); assert.equal(saved.cursor.node, null); assert.equal(saved.cursor.value, 2);
  assert.deepEqual(saved.snapshot, await handle.completion);
});

test('acceptance CAS failure poisons further writes and never dispatches the successor', async () => {
  const store = new Store(); let calls = 0, failedWrites = 0;
  store.hook = async c => { if (c.snapshot.steps.length) { failedWrites++; throw new Error('RUN_REVISION_CONFLICT'); } };
  const { compiled } = setup(async (c, input, identity) => { calls++; return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input }; });
  const handle = await new WorkflowRuntime().startPersisted(compiled, 'run', 0, store);
  await assert.rejects(handle.completion, /RUN_REVISION_CONFLICT/);
  assert.equal(calls, 1); assert.equal(failedWrites, 1); assert.equal(store.latest().snapshot.steps.length, 0);
});

test('failed initial storage or unavailable execution description never invokes a node', async () => {
  let calls = 0;
  const { compiled, executor } = setup(async () => { calls++; throw new Error('must not run'); });
  const broken = new Store(); broken.create = async () => { throw new Error('disk'); };
  await assert.rejects(new WorkflowRuntime().startPersisted(compiled, 'run', 0, broken), /disk/); assert.equal(calls, 0);
  delete executor.executionDefinition;
  const legacy = compileWorkflow(flow, { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'json', outcomes: { ok: 'json' } }, executor }) });
  await assert.rejects(new WorkflowRuntime().startPersisted(legacy, 'other', 0, new Store()), /EXECUTION_DEFINITION_UNAVAILABLE/); assert.equal(calls, 0);
});

for (const fails of [false, true]) test(`persistent cancellation waits for durable intent; write failure=${fails}`, async () => {
  const store = new Store(), running = deferred(), persist = deferred(), seen = deferred(), finish = deferred(); let calls = 0;
  const { compiled } = setup(async (c, _input, identity, cancellation) => {
    calls++; running.resolve(); await finish.promise; assert.equal(cancellation.requested(), true);
    return { identity, componentId: c.id, status: 'failed', code: 'CANCELLED', stopped: true, issues: [] };
  });
  const runtime = new WorkflowRuntime(), handle = await runtime.startPersisted(compiled, 'run', 0, store);
  // Attach rejection handling before deliberately failing concurrent writes.
  const completion = handle.completion.then(value => ({ value }), error => ({ error }));
  await running.promise;
  assert.throws(() => runtime.cancel('run'), /USE_PERSISTENT_CANCELLATION/);
  store.hook = async c => { if (c.snapshot.status === 'cancelling') { seen.resolve(); await persist.promise; if (fails) throw new Error('disk'); } };
  let acknowledged = false;
  const cancellation = handle.cancel().then(value => { acknowledged = value; return value; });
  const cancellationResult = cancellation.then(value => ({ value }), error => ({ error }));
  await seen.promise; assert.equal(acknowledged, false); assert.equal(store.latest().snapshot.cancelRequested, false);
  persist.resolve(); const result = await cancellationResult;
  if (fails) { assert.ok('error' in result); assert.equal(acknowledged, false); } else { assert.equal(acknowledged, true); assert.equal(store.latest().snapshot.cancelRequested, true); }
  finish.resolve(); const terminal = await completion;
  if (fails) assert.ok('error' in terminal); else { assert.ok('value' in terminal); assert.equal(terminal.value.status, 'cancelled'); assert.equal(store.latest().snapshot.status, 'cancelled'); }
  assert.equal(calls, 1);
});

test('persistent routing shares reentry identities, traversal counts and exhausted outcomes with ordinary execution', async () => {
  const loop: WorkflowDefinition = { ...flow, nodes: { a: { component: 'a' } }, routes: [{ from: 'a', outcome: 'ok', to: { node: 'a' }, limit: { max: 1, exhausted: { end: 'done' } } }] };
  const { compiled } = setup(async (c, input, identity) => ({ identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: (input as number) + 1 }), loop);
  const ordinary = await new WorkflowRuntime().start(compiled, 'run', 0).completion, store = new Store();
  const persisted = await (await new WorkflowRuntime().startPersisted(compiled, 'run', 0, store)).completion;
  assert.deepEqual(persisted, ordinary); assert.equal(persisted.status, 'exhausted');
  assert.deepEqual(persisted.steps.map(s => s.result.identity.nodeTaskId), ['task-1', 'task-2']);
  assert.deepEqual(store.latest().cursor.traversals, { '["a","ok"]': 1 }); assert.equal(store.latest().values.length, 3);
});


test('failed terminal commit cannot leave query reporting durable success', async () => {
  const store = new Store();
  store.hook = async c => { if (c.snapshot.status === 'succeeded') throw new Error('disk'); };
  const { compiled } = setup(async (c, input, identity) => ({ identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input }));
  const handle = await new WorkflowRuntime().startPersisted(compiled, 'run', 0, store);
  await assert.rejects(handle.completion, /disk/);
  assert.equal(handle.query().status, 'failed'); assert.equal(handle.query().reason, 'WORKFLOW_PERSISTENCE_FAILED');
  assert.equal(store.latest().snapshot.status, 'running'); assert.equal(store.latest().snapshot.steps.length, 1);
});


test('cancellation cannot create an incomplete Run during initial value persistence', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const contract = { kind: 'files' as const, id: 'files' };
  const definition = { ...flow, input: contract, outcomes: { done: contract } };
  const executor: WorkflowNodeExecutor = {
    validate() {}, contract: () => contract,
    contractDefinition: id => ({ kind: 'files', id, definition: { rules: [], maxFiles: 0, maxTotalBytes: 0, unmatched: 'reject' }, jsonContracts: {} }),
    executionDefinition: async () => ({ schema: 'test-files/v1' }), check: () => [],
    checkpointValue: async value => { if (++calls === 1) { entered.resolve(); await release.promise; } return { schema: 'test-file-value/v1', value }; },
    execute: async (c, input, identity) => ({ identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input })
  };
  const compiled = compileWorkflow(definition, { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'files', outcomes: { ok: 'files' } }, executor }) });
  const store = new Store(), runtime = new WorkflowRuntime(), starting = runtime.startPersisted(compiled, 'run', 0, store);
  await entered.promise;
  try {
    await assert.rejects(runtime.cancelPersisted('run'), /PERSISTENT_RUN_NOT_READY/);
    assert.equal(runtime.query('run').cancelRequested, false); assert.equal(store.records.length, 0);
  } finally { release.resolve(); }
  const handle = await starting;
  assert.equal((await handle.completion).status, 'succeeded'); assert.equal(store.latest().values.length, 3);
});
