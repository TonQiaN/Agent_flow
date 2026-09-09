import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import { loadWorkflowCheckpoint } from './load-checkpoint.js';
import type { WorkflowNodeExecutor } from './types.js';
import type { RunRecord, RunRecordStore } from '../persistence/types.js';
import type { RunnerResourceCheckpoint, RunnerResourceSink } from '../runner/types.js';
import { runnerLaunchStates } from '../runner/launch.js';
const environment = { schema: 'test-runner/v1' };
const resource = (identity: ExecutionIdentity): RunnerResourceCheckpoint => ({ schema: 'agentflow-runner-resource/v1', identity: structuredClone(identity), resource: { id: `${identity.runId}-${identity.nodeTaskId}` }, execution: environment, backend: { schema: 'test-resource/v1' } });
class Store implements RunRecordStore {
  records: RunRecord[] = []; fail = false;
  async create(runId: string, content: JsonValue) { const r = { runId, revision: 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r); }
  async read() { return structuredClone(this.records.at(-1) ?? null); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue) {
    if (this.fail && (content as any).attempts.some((a: any) => a.resource)) throw new Error('RESOURCE_CAS_CONFLICT');
    assert.equal(this.records.at(-1)!.revision, revision); const r = { runId, revision: revision + 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r);
  }
}
function compiled(execute: WorkflowNodeExecutor['execute']) {
  const executor: WorkflowNodeExecutor = { validate() {}, contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: true }),
    executionDefinition: async () => ({ schema: 'test-execution/v1' }), resourceDefinition: async () => structuredClone(environment), check: () => [], execute };
  const value = { kind: 'json' as const, id: 'value' };
  return compileWorkflow({ id: 'resources', start: 'a', maxSteps: 2, input: value, outcomes: { done: value }, nodes: { a: { component: 'a' }, b: { component: 'b' } },
    routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] }, {
    resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'value', outcomes: { ok: 'value' } }, executor }) });
}
test('normal Workflow saves actual per-Attempt resource before continuation and links results without copying outputs', async () => {
  const store = new Store();
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    assert.ok(sink); const saved = resource(identity); await sink.save(saved);
    (saved.identity as any).runId = 'mutated';
    const attempt = ((await store.read())!.content as any).attempts.at(-1);
    assert.deepEqual(attempt.identity, identity); assert.deepEqual(attempt.resource.identity, identity); assert.equal(attempt.resultStep, null);
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  await (await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion;
  const last = (await store.read())!.content as any;
  assert.equal(last.schema, 'agentflow-workflow-checkpoint/v3'); assert.deepEqual(last.attempts.map((a: any) => a.resultStep), [0, 1]);
  for (const record of store.records) { const loaded = await loadWorkflowCheckpoint(flow, 'run', { read: async () => record }); await loaded.dispose(); }
});
test('resource CAS rejection blocks continuation and successor and leaves the last complete Attempt record', async () => {
  const store = new Store(); store.fail = true; let continued = false, calls = 0;
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    calls++; await sink!.save(resource(identity)); continued = true;
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  await assert.rejects((await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion, /RESOURCE_CAS_CONFLICT/);
  assert.equal(continued, false); assert.equal(calls, 1);
  const loaded = await loadWorkflowCheckpoint(flow, 'run', store); assert.equal(loaded.checkpoint.attempts[0]!.resource, null); await loaded.dispose();
});
test('resource ports reject cross identity, changed environment, duplicate and late saves', async () => {
  const store = new Store(); let retained: RunnerResourceSink | undefined, retainedIdentity: ExecutionIdentity | undefined;
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    const wrong = resource(identity); (wrong.identity as any).runId = 'other'; await assert.rejects(sink!.save(wrong), /WORKFLOW_RESOURCE_MISMATCH/);
    await assert.rejects(sink!.save({ ...resource(identity), execution: { schema: 'changed' } }), /WORKFLOW_RESOURCE_MISMATCH/);
    await sink!.save(resource(identity)); await assert.rejects(sink!.save(resource(identity)), /WORKFLOW_RESOURCE_PORT_CLOSED/);
    retained = sink; retainedIdentity = identity;
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  await (await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion;
  await assert.rejects(retained!.save(resource(retainedIdentity!)), /WORKFLOW_RESOURCE_PORT_CLOSED/);
});
test('strict loading rejects missing/changed Attempt history, wrong resource identity and execution drift', async () => {
  const store = new Store();
  const flow = compiled(async (c, input, identity, _cancel, sink) => { await sink!.save(resource(identity)); return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input }; });
  await (await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion;
  const original = (await store.read())!;
  const changes: ((c: any) => void)[] = [c => { c.schema = 'agentflow-workflow-checkpoint/v1'; delete c.attempts; }, c => { c.attempts.pop(); },
    c => { c.attempts[0].identity.attemptNumber = 2; }, c => { c.attempts[0].resultStep = 1; }, c => { c.attempts[0].node = 'b'; },
    c => { c.attempts[1].resource.identity = c.attempts[0].identity; }, c => { c.attempts[1].resource.resource.id = c.attempts[0].resource.resource.id; },
    c => { c.attempts[0].resource.execution = { schema: 'changed' }; }];
  for (const mutate of changes) { const record = structuredClone(original); mutate(record.content); await assert.rejects(loadWorkflowCheckpoint(flow, 'run', { read: async () => record })); }
});
test('concurrent Runs use invocation-local sinks and retain independent resource histories', async () => {
  const stores = { one: new Store(), two: new Store() }; let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let waiting = 0;
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    if (c.id === 'a') { if (++waiting === 2) release(); await gate; }
    await sink!.save(resource(identity));
    const last = (await stores[identity.runId as keyof typeof stores].read())!.content as any;
    assert.equal(last.attempts.at(-1).resource.identity.runId, identity.runId);
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  const runtime = new WorkflowRuntime();
  await Promise.all(Object.entries(stores).map(async ([id, store]) => (await runtime.startPersisted(flow, id, 1, store)).completion));
  for (const [id, store] of Object.entries(stores)) { const loaded = await loadWorkflowCheckpoint(flow, id, store); assert.equal(loaded.checkpoint.attempts.length, 2); await loaded.dispose(); }
});
test('cancellation during a pending resource CAS preserves complete Attempt facts and blocks the successor', async () => {
  const store = new Store(), runtime = new WorkflowRuntime(); let entered!: () => void, release!: () => void;
  const seen = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const cas = store.compareAndSwap.bind(store); let held = false, calls = 0;
  store.compareAndSwap = async (id, revision, content) => {
    if (!held && (content as any).attempts.some((a: any) => a.resource)) { held = true; entered(); await gate; }
    return cas(id, revision, content);
  };
  const flow = compiled(async (c, _input, identity, cancellation, sink) => {
    calls++; await sink!.save(resource(identity)); assert.equal(cancellation.requested(), true);
    return { identity, componentId: c.id, status: 'failed', code: 'CANCELLED', stopped: true, issues: [] };
  });
  const handle = await runtime.startPersisted(flow, 'run', 1, store); await seen;
  const cancelled = handle.cancel(); release(); assert.equal(await cancelled, true);
  assert.equal((await handle.completion).status, 'cancelled'); assert.equal(calls, 1);
  for (const record of store.records) { const loaded = await loadWorkflowCheckpoint(flow, 'run', { read: async () => record }); await loaded.dispose(); }
  const last = (await store.read())!.content as any; assert.equal(last.attempts.length, 1); assert.equal(last.attempts[0].resultStep, 0);
  assert.equal(last.attempts[0].resource.identity.runId, 'run');
});

test('Workflow launch journal enforces ordered invocation-local transitions and validates every saved state', async () => {
  const store = new Store(); let retained: RunnerResourceSink | undefined;
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    assert.ok(sink?.launch); await assert.rejects(sink.launch('prepare_pending'), /WORKFLOW_LAUNCH_TRANSITION_INVALID/);
    await sink.save(resource(identity));
    await assert.rejects(sink.launch('start_pending'), /WORKFLOW_LAUNCH_TRANSITION_INVALID/);
    for (const state of runnerLaunchStates.slice(1)) {
      await sink.launch(state as Exclude<typeof state, 'allocated'>);
      assert.equal(((await store.read())!.content as any).attempts.at(-1).launch, state);
      await assert.rejects(sink.launch(state as Exclude<typeof state, 'allocated'>), /WORKFLOW_LAUNCH_TRANSITION_INVALID/);
    }
    await assert.rejects(sink.launch(undefined as any), /WORKFLOW_LAUNCH_TRANSITION_INVALID/);
    retained = sink; return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  await (await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion;
  await assert.rejects(retained!.launch!('prepare_pending'), /WORKFLOW_RESOURCE_PORT_CLOSED/);
  for (const record of store.records) { const loaded = await loadWorkflowCheckpoint(flow, 'run', { read: async () => record }); await loaded.dispose(); }
  for (const mutation of [(c: any) => { c.attempts[0].launch = null; }, (c: any) => { c.attempts[0].launch = 'other'; },
    (c: any) => { c.attempts[0].resource = null; }, (c: any) => { c.schema = 'agentflow-workflow-checkpoint/v2'; }]) {
    const record = structuredClone(store.records.at(-1)!); mutation(record.content);
    await assert.rejects(loadWorkflowCheckpoint(flow, 'run', { read: async () => record }));
  }
});
test('overlapping launch calls reject and a lost durable write permanently closes the invocation port', async () => {
  const store = new Store(); const cas = store.compareAndSwap.bind(store); let reject!: (error: Error) => void;
  store.compareAndSwap = async (id, revision, content) => (content as any).attempts.at(-1)?.launch === 'prepare_pending'
    ? new Promise((_r, failure) => { reject = failure; }) : cas(id, revision, content);
  const flow = compiled(async (c, input, identity, _cancel, sink) => {
    await sink!.save(resource(identity)); const pending = sink!.launch!('prepare_pending');
    await assert.rejects(sink!.launch!('prepare_completed'), /WORKFLOW_RESOURCE_PORT_CLOSED/);
    reject(new Error('owner lost')); await assert.rejects(pending, /owner lost/);
    await assert.rejects(sink!.launch!('prepare_completed'), /WORKFLOW_RESOURCE_PORT_CLOSED/);
    return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: input };
  });
  await assert.rejects((await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion, /owner lost/);
  assert.equal((store.records.at(-1)!.content as any).attempts[0].launch, 'allocated');
});
