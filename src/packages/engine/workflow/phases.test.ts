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
import type { InvocationPhaseSink, InvocationPhaseHandle, InvocationResourcePlan } from './phases.js';
import { validateInvocationPlan } from './phases.js';
const environment = { schema: 'phase-environment/v1' };
const plan: InvocationResourcePlan = { schema: 'agentflow-invocation-resources/v1', phases: [
  { id: 'check', kind: 'resource', execution: environment }, { id: 'local', kind: 'operation' }, { id: 'execute', kind: 'resource', execution: environment } ] };
class Store implements RunRecordStore {
  records: RunRecord[] = []; fail = false;
  async create(runId: string, content: JsonValue) { const r = { runId, revision: 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r); }
  async read() { return structuredClone(this.records.at(-1) ?? null); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue) {
    if (this.fail || this.records.at(-1)!.revision !== revision) throw new RunStoreError('RUN_REVISION_CONFLICT');
    const r = { runId, revision: revision + 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r);
  }
}
const record = (identity: ExecutionIdentity, id: string) => ({ schema: 'agentflow-runner-resource/v1' as const, identity, resource: { id: `${identity.nodeTaskId}-${identity.attemptId}-${id}` }, execution: environment, backend: null });
async function launched(phase: InvocationPhaseHandle, identity: ExecutionIdentity, id: string) {
  await phase.resource!.save(record(identity, id));
  for (const state of runnerLaunchStates.slice(1)) await phase.resource!.launch!(state as Exclude<typeof state, 'allocated'>);
}
function fixture(execute: WorkflowNodeExecutor['execute'], node = 'a', phased = true) {
  const calls: string[] = []; let stopped = true;
  const executor: WorkflowNodeExecutor = { validate() {}, check: () => [], contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: true }),
    executionDefinition: async () => ({ schema: 'phased/v1' }), resourcePlan: async () => phased ? plan : null, execute,
    restorePhaseResource: async (_c, phase, r) => {
      calls.push(`restore:${phase}`); return { identity: r.identity, resource: r.resource, query: async () => ({ state: 'running' }),
        stopAndRemove: async () => { calls.push(`stop:${phase}`); return { confirmed: stopped || phase === 'execute' }; }, release: async () => { calls.push(`release:${phase}`); } };
    } };
  const value = { kind: 'json' as const, id: 'value' };
  const flow = compileWorkflow({ id: 'phased', start: node, maxSteps: 1, input: value, outcomes: { done: value }, nodes: { [node]: { component: 'a' } }, routes: [{ from: node, outcome: 'ok', to: { end: 'done' } }] },
    { resolve: () => ({ component: { id: 'a', kind: 'transform', implementation: 'a', inputContract: 'value', outcomes: { ok: 'value' } }, executor }) });
  return { flow, executor, calls, stopped: (value: boolean) => { stopped = value; } };
}
const accepted = (componentId: string, identity: ExecutionIdentity, input: JsonValue) => ({ componentId, identity, status: 'accepted' as const, outcome: 'ok', output: input });
test('ordered phase records share one normal Workflow writer and all intermediate records load', async () => {
  const store = new Store(); let late!: InvocationPhaseSink;
  const f = fixture(async (c, input, identity, _cancel, single, phases) => {
    assert.equal(single, undefined); assert.ok(phases); late = phases;
    await assert.rejects(phases.enter('execute'), /WORKFLOW_PHASE_TRANSITION_INVALID/);
    const first = await phases.enter('check'); await assert.rejects(phases.enter('local'), /WORKFLOW_PHASE_TRANSITION_INVALID/);
    await launched(first, identity, 'check'); await assert.rejects(first.resource!.launch!(undefined as any), /WORKFLOW_LAUNCH_TRANSITION_INVALID/); await first.complete();
    await assert.rejects(first.complete(), /WORKFLOW_RESOURCE_PORT_CLOSED/);
    const operation = await phases.enter('local'); assert.equal(operation.resource, undefined); await operation.complete();
    const execution = await phases.enter('execute'); await launched(execution, identity, 'execute'); await execution.complete();
    return accepted(c.id, identity, input);
  });
  assert.equal((await (await new WorkflowRuntime().startPersisted(f.flow, 'run', 1, store)).completion).status, 'succeeded');
  await assert.rejects(late.enter('check'), /WORKFLOW_RESOURCE_PORT_CLOSED/);
  for (const r of store.records) { const loaded = await loadWorkflowCheckpoint(f.flow, 'run', { read: async () => r }); await loaded.dispose(); }
  const last: any = store.records.at(-1)!.content; assert.equal(last.execution.version, 2); assert.deepEqual(last.execution.resourcePlans.a, plan);
});
test('missing phase completion cannot be accepted as business success', async () => {
  const f = fixture(async (c, input, identity, _cancel, _single, phases) => { await phases!.enter('check'); return accepted(c.id, identity, input); });
  const store = new Store(), result = await (await new WorkflowRuntime().startPersisted(f.flow, 'run', 1, store)).completion;
  assert.equal(result.reason, 'WORKFLOW_PHASES_INCOMPLETE'); assert.equal(result.steps.length, 0);
  const loaded = await loadWorkflowCheckpoint(f.flow, 'run', store); await loaded.dispose();
});
test('CAS failure while entering a local operation prevents its side effect and closes the lane', async () => {
  const store = new Store(); let entered = false;
  const f = fixture(async (c, input, identity, _cancel, _single, phases) => {
    const first = await phases!.enter('check'); await launched(first, identity, 'check'); await first.complete();
    store.fail = true; await phases!.enter('local'); entered = true; return accepted(c.id, identity, input);
  });
  await assert.rejects((await new WorkflowRuntime().startPersisted(f.flow, 'run', 1, store)).completion, /RUN_REVISION_CONFLICT/); assert.equal(entered, false);
});
async function paused(at: 'operation' | 'resource') {
  let enter!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; }); let runs = 0;
  const f = fixture(async (c, input, identity, _cancel, _single, phases) => {
    runs++; const first = await phases!.enter('check'); await launched(first, identity, 'check'); await first.complete();
    const op = await phases!.enter('local');
    if (at === 'operation' && identity.attemptNumber === 1) { enter(); await gate; }
    await op.complete(); const execution = await phases!.enter('execute'); await launched(execution, identity, 'execute');
    if (at === 'resource' && identity.attemptNumber === 1) { enter(); await gate; }
    await execution.complete(); return accepted(c.id, identity, input);
  });
  const store = new Store(), handle = await new WorkflowRuntime().startPersisted(f.flow, 'run', 1, store), old = handle.completion.catch(e => e); await Promise.race([reached, old.then(result => { throw new Error(`Workflow ended before pause: ${JSON.stringify(result)}`); })]);
  return { ...f, store, old, release, runs: () => runs };
}
test('an unfinished local operation refuses a recovery claim without touching any old resource', async () => {
  const f = await paused('operation'), before = await f.store.read();
  try { await assert.rejects(claimWorkflowRecovery(f.flow, 'run', f.store), /WORKFLOW_LAUNCH_UNCONFIRMED/); assert.deepEqual(await f.store.read(), before); assert.deepEqual(f.calls, []); }
  finally { f.release(); await f.old; }
});
test('recovery cleans every phase in reverse order, retries partial cleanup and resumes only a fresh Attempt', async () => {
  const f = await paused('resource');
  try {
    const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store); f.stopped(false);
    await assert.rejects(recovery.cleanup(), /WORKFLOW_RECOVERY_STOP_UNCONFIRMED/); assert.equal(recovery.query().resourceRemoved, false);
    assert.deepEqual(f.calls, ['restore:execute', 'stop:execute', 'release:execute', 'restore:check', 'stop:check']);
    f.stopped(true); await recovery.cleanup(); const runtime = new WorkflowRuntime(); const resumed = await runtime.resumePersisted(recovery);
    assert.equal((await resumed.completion).status, 'succeeded'); assert.equal(f.runs(), 2);
    f.release(); assert.equal((await f.old).code, 'RUN_REVISION_CONFLICT');
    for (const r of f.store.records) { const loaded = await loadWorkflowCheckpoint(f.flow, 'run', { read: async () => r }); await loaded.dispose(); }
    await resumed.dispose();
  } finally { f.release(); await f.old; }
});
test('phase identity, plan, operation shape, duplicate resources and old formats fail before claim', async () => {
  const f = await paused('resource'), original = (await f.store.read())!;
  try {
    for (const mutate of [(c: any) => { c.schema = 'agentflow-workflow-checkpoint/v4'; }, (c: any) => { c.execution.resourcePlans.a.phases.reverse(); },
      (c: any) => { c.attempts[0].phases[1].resource = c.attempts[0].phases[0].resource; },
      (c: any) => { c.attempts[0].phases[2].resource.resource.id = c.attempts[0].phases[0].resource.resource.id; },
      (c: any) => { c.attempts[0].phases[2].resource.identity.runId = 'other'; },
      (c: any) => { c.attempts[0].phases[2].resource.execution = { schema: 'other' }; },
      (c: any) => { c.attempts[0].phases[0].status = 'active'; }]) {
      const changed = structuredClone(original); mutate(changed.content); await assert.rejects(loadWorkflowCheckpoint(f.flow, 'run', { read: async () => changed }));
    }
    assert.deepEqual(f.calls, []); assert.deepEqual(await f.store.read(), original);
  } finally { f.release(); await f.old; }
  for (const value of [{ ...plan, phases: [] }, { ...plan, phases: [plan.phases[0], plan.phases[0]] }, { ...plan, extra: true }]) assert.throws(() => validateInvocationPlan(value));
});

test('prototype property node names use only explicitly registered resource plans', async () => {
  for (const node of ['constructor', 'toString']) for (const phased of [false, true]) {
    const f = fixture(async (c, input, identity, _cancel, _single, phases) => {
      assert.equal(Boolean(phases), phased);
      if (phases) for (const id of ['check', 'local', 'execute']) {
        const p = await phases.enter(id); if (p.resource) await launched(p, identity, id); await p.complete();
      }
      return accepted(c.id, identity, input);
    }, node, phased);
    const store = new Store();
    assert.equal((await (await new WorkflowRuntime().startPersisted(f.flow, 'run', 1, store)).completion).status, 'succeeded');
    for (const r of store.records) { const loaded = await loadWorkflowCheckpoint(f.flow, 'run', { read: async () => r }); await loaded.dispose(); }
  }
});

test('single-resource successors cannot reuse a prior phase resource identity', async () => {
  let oldId = '';
  const f = fixture(async (c, input, identity, _cancel, single, phases) => {
    if (phases) {
      for (const id of ['check', 'local', 'execute']) {
        const p = await phases.enter(id);
        if (p.resource) { oldId = record(identity, id).resource.id; await launched(p, identity, id); }
        await p.complete();
      }
    } else {
      const r = record(identity, 'duplicate'); r.resource.id = oldId;
      await assert.rejects(single!.save(r), /WORKFLOW_RESOURCE_MISMATCH/);
      await single!.save(record(identity, 'unique'));
    }
    return accepted(c.id, identity, input);
  });
  f.executor.resourcePlan = async c => c.id === 'a' ? plan : null;
  f.executor.resourceDefinition = async () => environment;
  const value = { kind: 'json' as const, id: 'value' };
  const flow = compileWorkflow({ id: 'mixed', start: 'a', maxSteps: 2, input: value, outcomes: { done: value },
    nodes: { a: { component: 'a' }, b: { component: 'b' } },
    routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] },
    { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'value', outcomes: { ok: 'value' } }, executor: f.executor }) });
  const store = new Store(); assert.equal((await (await new WorkflowRuntime().startPersisted(flow, 'run', 1, store)).completion).status, 'succeeded');
  for (const r of store.records) { const loaded = await loadWorkflowCheckpoint(flow, 'run', { read: async () => r }); await loaded.dispose(); }
});
