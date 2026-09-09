import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { RunStoreError, type RunRecord, type RunRecordStore } from '../persistence/types.js';
import { runnerLaunchStates } from '../runner/launch.js';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import { claimWorkflowRecovery } from './recovery.js';
import { loadWorkflowCheckpoint } from './load-checkpoint.js';
import type { WorkflowNodeExecutor } from './types.js';

class Store implements RunRecordStore {
  record: RunRecord | null = null; records: RunRecord[] = [];
  save(runId: string, revision: number, content: JsonValue) {
    this.record = { runId, revision, content: structuredClone(content) }; this.records.push(structuredClone(this.record)); return structuredClone(this.record);
  }
  async create(runId: string, content: JsonValue) { return this.save(runId, 1, content); }
  async read() { return structuredClone(this.record); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue) {
    if (this.record?.revision !== revision) throw new RunStoreError('RUN_REVISION_CONFLICT');
    return this.save(runId, revision + 1, content);
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(pauses = 1, reentry = false) {
  const store = new Store(), entered = Array.from({ length: pauses }, deferred), gates = Array.from({ length: pauses }, deferred);
  const calls: { node: string; identity: ExecutionIdentity }[] = [];
  const executor: WorkflowNodeExecutor = {
    validate() {}, contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: true }), check: () => [],
    executionDefinition: async () => ({ schema: 'fixture-script/v1' }), resourceDefinition: async () => ({ schema: 'fixture-backend/v1' }),
    execute: async (component, input, identity, _cancel, sink) => {
      calls.push({ node: component.id, identity });
      await sink!.save({ schema: 'agentflow-runner-resource/v1', identity, resource: { id: `${identity.nodeTaskId}-${identity.attemptId}` }, execution: { schema: 'fixture-backend/v1' }, backend: null });
      for (const state of runnerLaunchStates.slice(1)) await sink!.launch!(state as Exclude<typeof state, 'allocated'>);
      if (component.id === 'b' && identity.attemptNumber <= pauses) { entered[identity.attemptNumber - 1]!.resolve(); await gates[identity.attemptNumber - 1]!.promise; }
      return { componentId: component.id, identity, status: 'accepted', outcome: identity.nodeTaskId === 'task-3' ? 'done' : 'ok', output: `${input}${component.id.toUpperCase()}` };
    },
    restoreResource: async (_component, record) => ({ identity: record.identity, resource: record.resource,
      query: async () => ({ state: 'running' }), stopAndRemove: async () => ({ confirmed: true }), release: async () => {} }),
  };
  const value = { kind: 'json' as const, id: 'value' };
  const flow = compileWorkflow({ id: 'resume', start: 'a', maxSteps: reentry ? 3 : 2, input: value, outcomes: { done: value },
    nodes: { a: { component: 'a' }, b: { component: 'b' } }, routes: [
      { from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'a', outcome: 'done', to: { end: 'done' } },
      { from: 'b', outcome: 'done', to: { end: 'done' } },
      { from: 'b', outcome: 'ok', to: reentry ? { node: 'a' } : { end: 'done' }, limit: { max: 1, exhausted: { end: 'done' } } },
    ] }, { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'value', outcomes: { ok: 'value', done: 'value' } }, executor }) });
  const original = await new WorkflowRuntime().startPersisted(flow, 'run', '', store), old = original.completion.catch(e => e);
  await entered[0]!.promise;
  return { store, flow, calls, entered, gates, old, close: async () => { gates.forEach(g => g.resolve()); await old; } };
}
async function validateRecords(f: Awaited<ReturnType<typeof fixture>>) {
  for (const record of f.store.records) {
    const loaded = await loadWorkflowCheckpoint(f.flow, 'run', { read: async () => structuredClone(record) });
    await loaded.dispose();
  }
}

test('resume keeps completed A, retries interrupted B within the same task and rejects late old results', async () => {
  const f = await fixture();
  try {
    const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store);
    await assert.rejects(new WorkflowRuntime().resumePersisted({ ...recovery }), /UNTRUSTED_WORKFLOW_RECOVERY_HANDLE/);
    await assert.rejects(new WorkflowRuntime().resumePersisted(recovery), /WORKFLOW_RECOVERY_NOT_READY/);
    await recovery.cleanup();
    const resumed = await new WorkflowRuntime().resumePersisted(recovery); await recovery.dispose();
    const result = await resumed.completion; assert.equal(result.status, 'succeeded'); assert.equal(result.lastAccepted!.result.status, 'accepted');
    assert.deepEqual(f.calls.map(c => [c.node, c.identity.nodeTaskId, c.identity.attemptNumber]), [['a', 'task-1', 1], ['b', 'task-2', 1], ['b', 'task-2', 2]]);
    assert.equal((result.lastAccepted!.result as any).output, 'AB'); assert.equal(result.steps.length, 2);
    const saved = structuredClone(f.store.record!); assert.deepEqual((saved.content as any).attempts.map((a: any) => a.interrupted), [false, true, false]);
    f.gates[0]!.resolve(); assert.equal((await f.old).code, 'RUN_REVISION_CONFLICT'); assert.deepEqual(f.store.record, saved);
    await assert.rejects(new WorkflowRuntime().resumePersisted(recovery), /UNTRUSTED_WORKFLOW_RECOVERY_HANDLE/);
    await validateRecords(f); await resumed.dispose();
  } finally { await f.close(); }
});

test('another recovery claim fences a stale resume before any new executor call', async () => {
  const f = await fixture();
  try {
    const first = await claimWorkflowRecovery(f.flow, 'run', f.store); await first.cleanup();
    const second = await claimWorkflowRecovery(f.flow, 'run', f.store); await second.cleanup();
    const runtime = new WorkflowRuntime(); await assert.rejects(runtime.resumePersisted(first), /RUN_REVISION_CONFLICT/);
    assert.equal(f.calls.length, 2);
    const resumed = await runtime.resumePersisted(second); assert.equal((await resumed.completion).status, 'succeeded');
    await resumed.dispose(); await validateRecords(f);
  } finally { await f.close(); }
});

test('repeated host interruption retains every Attempt and increments only the interrupted task', async () => {
  const f = await fixture(2);
  try {
    const first = await claimWorkflowRecovery(f.flow, 'run', f.store); await first.cleanup();
    const middle = await new WorkflowRuntime().resumePersisted(first), middleDone = middle.completion.catch(e => e);
    await f.entered[1]!.promise;
    const second = await claimWorkflowRecovery(f.flow, 'run', f.store); await second.cleanup();
    const last = await new WorkflowRuntime().resumePersisted(second); assert.equal((await last.completion).status, 'succeeded');
    assert.deepEqual(f.calls.map(c => c.identity.attemptNumber), [1, 1, 2, 3]);
    assert.deepEqual((f.store.record!.content as any).attempts.map((a: any) => a.interrupted), [false, true, true, false]);
    f.gates[1]!.resolve(); assert.equal((await middleDone).code, 'RUN_REVISION_CONFLICT');
    await middle.dispose(); await last.dispose(); await validateRecords(f);
  } finally { await f.close(); }
});

test('route reentry after resume creates a new NodeTask without consuming an extra maxSteps slot', async () => {
  const f = await fixture(1, true);
  try {
    const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store); await recovery.cleanup();
    const resumed = await new WorkflowRuntime().resumePersisted(recovery), result = await resumed.completion;
    assert.equal(result.status, 'succeeded'); assert.equal((result.lastAccepted!.result as any).output, 'ABA');
    assert.deepEqual(f.calls.map(c => [c.identity.nodeTaskId, c.identity.attemptNumber]), [['task-1', 1], ['task-2', 1], ['task-2', 2], ['task-3', 1]]);
    await validateRecords(f); await resumed.dispose();
  } finally { await f.close(); }
});

test('interruption immediately after resume handoff preserves the next unused Attempt number', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  try {
    const first = await claimWorkflowRecovery(f.flow, 'run', f.store); await first.cleanup();
    const cas = f.store.compareAndSwap.bind(f.store); let paused = false;
    f.store.compareAndSwap = async (id, revision, content) => {
      const record = await cas(id, revision, content);
      if (!paused && (content as any).attempts?.at(-1)?.interrupted) { paused = true; entered.resolve(); await gate.promise; }
      return record;
    };
    const pending = new WorkflowRuntime().resumePersisted(first); await entered.promise;
    const next = await claimWorkflowRecovery(f.flow, 'run', f.store); assert.equal(next.query().resourceRemoved, true); await next.cleanup();
    const resumed = await new WorkflowRuntime().resumePersisted(next); assert.equal((await resumed.completion).status, 'succeeded');
    gate.resolve(); const stale = await pending; await assert.rejects(stale.completion, /RUN_REVISION_CONFLICT/); await stale.dispose();
    assert.deepEqual(f.calls.map(c => c.identity.attemptNumber), [1, 1, 2]); await validateRecords(f); await resumed.dispose();
  } finally { gate.resolve(); await f.close(); }
});

test('cancellation immediately after resume is durable and prevents another executor call', async () => {
  const f = await fixture();
  try {
    const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store); await recovery.cleanup();
    const resumed = await new WorkflowRuntime().resumePersisted(recovery); await resumed.cancel();
    assert.equal((await resumed.completion).status, 'cancelled'); assert.equal(f.calls.length, 2);
    await validateRecords(f); await resumed.dispose();
  } finally { await f.close(); }
});

test('strict loading rejects corrupted interrupted history and the old trial schema', async () => {
  const f = await fixture();
  try {
    const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store); await recovery.cleanup();
    const resumed = await new WorkflowRuntime().resumePersisted(recovery); await resumed.completion;
    const saved = structuredClone(f.store.record!);
    for (const mutate of [(c: any) => { c.schema = 'agentflow-workflow-checkpoint/v3'; },
      (c: any) => { c.attempts[1].interrupted = false; }, (c: any) => { c.attempts[1].launch = 'start_pending'; },
      (c: any) => { c.attempts[1].resultStep = 1; }, (c: any) => { c.attempts[2].identity.attemptNumber = 3; },
      (c: any) => { c.attempts[2].node = 'a'; }, (c: any) => { c.attempts[2].resource.resource.id = c.attempts[1].resource.resource.id; }]) {
      f.store.record = structuredClone(saved); mutate(f.store.record.content);
      await assert.rejects(loadWorkflowCheckpoint(f.flow, 'run', f.store));
    }
    f.store.record = saved; await resumed.dispose();
  } finally { await f.close(); }
});

for (const boundary of ['queued', 'after-a']) test(`resume continues the next unused task from the durable ${boundary} boundary`, async () => {
  const f = await fixture();
  try {
    const source = f.store.records.find(r => { const c = r.content as any; return boundary === 'queued' ? c.snapshot.status === 'queued'
      : c.snapshot.steps.length === 1 && c.snapshot.currentIdentity === null; })!;
    assert.ok(source);
    const store = new Store(); store.record = structuredClone(source);
    const recovery = await claimWorkflowRecovery(f.flow, 'run', store); assert.equal(recovery.query().resourceRemoved, true);
    const start = f.calls.length; f.gates[0]!.resolve(); await f.old;
    const resumed = await new WorkflowRuntime().resumePersisted(recovery); assert.equal((await resumed.completion).status, 'succeeded');
    assert.deepEqual(f.calls.slice(start).map(c => [c.node, c.identity.attemptNumber]), boundary === 'queued' ? [['a', 1], ['b', 1]] : [['b', 1]]);
    const loaded = await loadWorkflowCheckpoint(f.flow, 'run', store); await loaded.dispose(); await resumed.dispose();
  } finally { await f.close(); }
});
