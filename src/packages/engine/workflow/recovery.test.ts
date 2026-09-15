import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@agentflow/domain';
import { RunStoreError } from '../persistence/types.js';
import type { RunRecord, RunRecordStore } from '../persistence/types.js';
import type { RestoredRunnerResource } from '../runner/types.js';
import { runnerLaunchStates } from '../runner/launch.js';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import { claimWorkflowRecovery } from './recovery.js';
import { loadWorkflowCheckpoint } from './load-checkpoint.js';
import type { WorkflowNodeExecutor } from './types.js';

class Store implements RunRecordStore {
  record: RunRecord | null = null;
  async create(runId: string, content: JsonValue) { this.record = { runId, revision: 1, content: structuredClone(content) }; return structuredClone(this.record); }
  async read() { return structuredClone(this.record); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue) {
    if (this.record?.revision !== revision) throw new RunStoreError('RUN_REVISION_CONFLICT');
    this.record = { runId, revision: revision + 1, content: structuredClone(content) }; return structuredClone(this.record);
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const store = new Store(), gate = deferred(), entered = deferred(); let executes = 0, stopped = true, queryFails = false;
  const calls: string[] = []; let onQuery = async () => {}, alter: (r: RestoredRunnerResource) => RestoredRunnerResource = r => r;
  const executor: WorkflowNodeExecutor = {
    validate() {}, contract: id => ({ kind: 'json', id }), contractDefinition: id => ({ kind: 'json', id, schema: true }), check: () => [],
    executionDefinition: async () => ({ schema: 'fixture-script/v1' }), resourceDefinition: async () => ({ schema: 'fixture-backend/v1' }),
    execute: async (component, input, identity, _cancel, sink) => {
      executes++; await sink!.save({ schema: 'agentflow-runner-resource/v1', identity, resource: { id: 'old-resource' }, execution: { schema: 'fixture-backend/v1' }, backend: null });
      for (const state of runnerLaunchStates.slice(1)) await sink!.launch!(state as Exclude<typeof state, 'allocated'>);
      entered.resolve(); await gate.promise;
      return { componentId: component.id, identity, status: 'accepted', outcome: 'ok', output: input };
    },
    restoreResource: async (_component, record) => {
      calls.push('restore'); return alter({ identity: record.identity, resource: record.resource,
        query: async () => { calls.push('query'); await onQuery(); if (queryFails) throw new Error('query unavailable'); return { state: 'running' }; },
        stopAndRemove: async () => { calls.push('stop'); return { confirmed: stopped }; }, release: async () => { calls.push('release'); } });
    },
  };
  const value = { kind: 'json' as const, id: 'value' };
  const compile = (restore = true) => compileWorkflow({ id: 'recover', start: 'a', maxSteps: 1, input: value, outcomes: { done: value },
    nodes: { a: { component: 'a' } }, routes: [{ from: 'a', outcome: 'ok', to: { end: 'done' } }] }, {
    resolve: () => ({ component: { id: 'a', kind: 'transform', implementation: 'a', inputContract: 'value', outcomes: { ok: 'value' } },
      executor: restore ? executor : { ...executor, restoreResource: undefined } as unknown as WorkflowNodeExecutor }) });
  const flow = compile(), handle = await new WorkflowRuntime().startPersisted(flow, 'run', 1, store);
  const completion = handle.completion.catch(e => e); await entered.promise;
  return { store, flow, compile, calls, gate, completion, executes: () => executes,
    stopped: (v: boolean) => { stopped = v; }, queryFails: (v: boolean) => { queryFails = v; }, onQuery: (f: () => Promise<void>) => { onQuery = f; },
    alter: (f: typeof alter) => { alter = f; } };
}
test('recovery claims before common cleanup, preserves business history and fences a live host late result', async () => {
  const f = await fixture(), original = (await f.store.read())!;
  const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store);
  assert.deepEqual(f.calls, []); assert.equal(recovery.query().claimRevision, original.revision + 1);
  assert.deepEqual(recovery.query().checkpoint, original.content);
  (recovery.query().checkpoint as any).snapshot.status = 'succeeded';
  const result = await recovery.cleanup(); assert.equal(result.resourceRemoved, true);
  assert.deepEqual(f.calls, ['restore', 'query', 'stop', 'release']);
  f.gate.resolve(); assert.equal((await f.completion).code, 'RUN_REVISION_CONFLICT'); assert.equal(f.executes(), 1);
  assert.deepEqual((f.store.record!.content as any).checkpoint, original.content); await recovery.dispose();
});
test('two recoverers reading one revision have exactly one winning CAS and no loser side effects', async () => {
  const f = await fixture(), read = f.store.read.bind(f.store), barrier = deferred(); let readers = 0;
  f.store.read = async () => { const r = await read(); if (++readers === 2) barrier.resolve(); await barrier.promise; return r; };
  const results = await Promise.allSettled([claimWorkflowRecovery(f.flow, 'run', f.store), claimWorkflowRecovery(f.flow, 'run', f.store)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(f.calls, []);
  const winner = results.find(r => r.status === 'fulfilled')!; assert.equal(winner.status, 'fulfilled');
  if (winner.status === 'fulfilled') { await winner.value.cleanup(); await winner.value.dispose(); }
  assert.equal(f.calls.filter(c => c === 'restore').length, 1); f.gate.resolve(); await f.completion;
});
test('a later claim preserves completed cleanup and closes the old handle at its next CAS', async () => {
  const f = await fixture(), first = await claimWorkflowRecovery(f.flow, 'run', f.store); await first.cleanup();
  const second = await claimWorkflowRecovery(f.flow, 'run', f.store); const calls = [...f.calls];
  assert.ok(second.query().claimRevision > first.query().claimRevision); assert.equal(second.query().resourceRemoved, true);
  await assert.rejects(first.cleanup(), /RUN_REVISION_CONFLICT/); await assert.rejects(first.cleanup(), /WORKFLOW_RECOVERY_HANDLE_CLOSED/);
  await second.cleanup(); assert.deepEqual(f.calls, calls);
  await first.dispose(); await second.dispose(); f.gate.resolve(); await f.completion;
});
test('pending launches, cancellation and missing recovery capability never acquire a claim', async () => {
  const f = await fixture(), original = structuredClone(f.store.record!);
  for (const state of ['prepare_pending', 'create_pending', 'start_pending']) {
    const changed = structuredClone(original); (changed.content as any).attempts[0].launch = state; f.store.record = changed;
    await assert.rejects(claimWorkflowRecovery(f.flow, 'run', f.store), /WORKFLOW_LAUNCH_UNCONFIRMED/); assert.deepEqual(f.store.record, changed);
  }
  f.store.record = structuredClone(original); (f.store.record.content as any).snapshot.cancelRequested = true; (f.store.record.content as any).snapshot.status = 'cancelling';
  await assert.rejects(claimWorkflowRecovery(f.flow, 'run', f.store), /WORKFLOW_NOT_RECOVERABLE/);
  f.store.record = original; await assert.rejects(claimWorkflowRecovery(f.compile(false), 'run', f.store), /WORKFLOW_RESOURCE_RESTORE_UNAVAILABLE/);
  assert.deepEqual(f.store.record, original); assert.deepEqual(f.calls, []);
  f.gate.resolve(); assert.equal((await f.completion).status, 'succeeded');
  await assert.rejects(claimWorkflowRecovery(f.flow, 'run', f.store), /WORKFLOW_NOT_RECOVERABLE/);
});
test('query and stop uncertainty retain recovery progress and retry through the same common handle', async () => {
  const f = await fixture(), recovery = await claimWorkflowRecovery(f.flow, 'run', f.store);
  f.queryFails(true); await assert.rejects(recovery.cleanup(), /WORKFLOW_RECOVERY_QUERY_UNCONFIRMED/); assert.deepEqual(f.calls, ['restore', 'query']);
  f.queryFails(false); f.stopped(false); await assert.rejects(recovery.cleanup(), /WORKFLOW_RECOVERY_STOP_UNCONFIRMED/);
  assert.equal(recovery.query().resourceRemoved, false); assert.equal(f.calls.includes('release'), false);
  f.stopped(true); const one = recovery.cleanup(), two = recovery.cleanup(); assert.equal(one, two);
  assert.equal((await one).resourceRemoved, true); assert.equal(f.calls.filter(c => c === 'restore').length, 1);
  await recovery.dispose(); f.gate.resolve(); await f.completion;
});
test('wrong restored resource identity cannot query, stop, or publish cleanup completion', async () => {
  const f = await fixture(); f.alter(r => ({ ...r, resource: { id: 'other' } }));
  const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store);
  await assert.rejects(recovery.cleanup(), /WORKFLOW_RECOVERED_RESOURCE_MISMATCH/); assert.deepEqual(f.calls, ['restore']);
  assert.equal(recovery.query().resourceRemoved, false); await recovery.dispose(); f.gate.resolve(); await f.completion;
});
test('takeover during old cleanup rejects its late write while the new claim can finish', async () => {
  const f = await fixture(), seen = deferred(), gate = deferred();
  f.onQuery(async () => { seen.resolve(); await gate.promise; });
  const first = await claimWorkflowRecovery(f.flow, 'run', f.store), pending = first.cleanup(); await seen.promise;
  const second = await claimWorkflowRecovery(f.flow, 'run', f.store); gate.resolve();
  await assert.rejects(pending, /RUN_REVISION_CONFLICT/); assert.equal(second.query().resourceRemoved, false);
  assert.equal((await second.cleanup()).resourceRemoved, true);
  await first.dispose(); await second.dispose(); f.gate.resolve(); await f.completion;
});
test('dispose waits for an active cleanup commit and rejects new operations', async () => {
  const f = await fixture(), seen = deferred(), gate = deferred();
  f.onQuery(async () => { seen.resolve(); await gate.promise; });
  const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store), pending = recovery.cleanup(); await seen.promise;
  const disposed = recovery.dispose(); await assert.rejects(recovery.cleanup(), /WORKFLOW_RECOVERY_HANDLE_CLOSED/);
  gate.resolve(); assert.equal((await pending).resourceRemoved, true); await disposed; await recovery.dispose();
  f.gate.resolve(); await f.completion;
});
test('malformed recovery envelopes reject without changing storage or touching resources', async () => {
  const f = await fixture(), recovery = await claimWorkflowRecovery(f.flow, 'run', f.store), original = structuredClone(f.store.record!);
  for (const mutate of [(c: any) => { c.extra = true; }, (c: any) => { c.claimRevision = 0; }, (c: any) => { c.claimRevision = 999; },
    (c: any) => { c.resourceRemoved = 'yes'; }, (c: any) => { c.checkpoint.attempts[0].identity.runId = 'other'; }]) {
    f.store.record = structuredClone(original); mutate(f.store.record.content); const before = structuredClone(f.store.record);
    await assert.rejects(claimWorkflowRecovery(f.flow, 'run', f.store)); assert.deepEqual(f.store.record, before);
  }
  assert.deepEqual(f.calls, []); f.store.record = original; await recovery.dispose(); f.gate.resolve(); await f.completion;
});
test('ordinary strict loading inspects recovery progress without taking a new claim or touching old resources', async () => {
  const f = await fixture(), recovery = await claimWorkflowRecovery(f.flow, 'run', f.store), before = structuredClone(f.store.record!);
  const loaded = await loadWorkflowCheckpoint(f.flow, 'run', f.store);
  assert.equal(loaded.revision, before.revision); assert.deepEqual(loaded.recovery, { claimRevision: recovery.query().claimRevision, resourceRemoved: false });
  (loaded.recovery as any).resourceRemoved = true; assert.equal(loaded.recovery!.resourceRemoved, false);
  assert.deepEqual(loaded.checkpoint, recovery.query().checkpoint); assert.deepEqual(f.store.record, before); assert.deepEqual(f.calls, []);
  await loaded.dispose(); await recovery.dispose(); f.gate.resolve(); await f.completion;
});
test('workspace release failure cannot publish completion and can be retried without exposing backend text', async () => {
  const f = await fixture(); let releases = 0;
  f.alter(r => ({ ...r, release: async () => { await r.release(); if (++releases === 1) throw new Error('private backend detail'); } }));
  const recovery = await claimWorkflowRecovery(f.flow, 'run', f.store);
  await assert.rejects(recovery.cleanup(), { message: 'WORKFLOW_RECOVERY_RELEASE_FAILED' });
  assert.equal(recovery.query().resourceRemoved, false); assert.equal((await recovery.cleanup()).resourceRemoved, true);
  assert.equal(releases, 2); assert.equal(f.calls.filter(c => c === 'restore').length, 1);
  await recovery.dispose(); f.gate.resolve(); await f.completion;
});
