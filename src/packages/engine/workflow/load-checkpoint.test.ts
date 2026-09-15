import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@agentflow/domain';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import { loadWorkflowCheckpoint } from './load-checkpoint.js';
import { consumeWorkflowValueRestore, WorkflowRestoreError } from './restore-value.js';
import type { WorkflowValueRestoreRequest } from './restore-value.js';
import type { WorkflowDefinition, WorkflowNodeExecutor } from './types.js';
import type { RunRecord, RunRecordStore } from '../persistence/types.js';
import { DefinitionError } from '../errors.js';
class Store implements RunRecordStore {
  records: RunRecord[] = [];
  async create(runId: string, content: JsonValue) { const r = { runId, revision: 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r); }
  async read() { return structuredClone(this.records.at(-1) ?? null); }
  async compareAndSwap(runId: string, revision: number, content: JsonValue) { assert.equal(this.records.at(-1)!.revision, revision); const r = { runId, revision: revision + 1, content: structuredClone(content) }; this.records.push(r); return structuredClone(r); }
}
async function generated(mode = 'normal', files = false, customize?: (executor: WorkflowNodeExecutor) => void) {
  const store = new Store(), runtime = new WorkflowRuntime(); let calls = 0;
  const cancellations: Promise<boolean>[] = [];
  const kind = files ? 'files' as const : 'json' as const, contract = { kind, id: 'value' };
  const definition: WorkflowDefinition = { id: 'loadable', start: 'a', input: contract, outcomes: { done: contract }, maxSteps: mode === 'max' ? 1 : 3,
    nodes: mode === 'limit' || mode === 'max' ? { a: { component: 'a' } } : { a: { component: 'a' }, b: { component: 'b' } },
    routes: mode === 'limit' || mode === 'max' ? [{ from: 'a', outcome: 'ok', to: { node: 'a' }, limit: { max: mode === 'max' ? 2 : 1, exhausted: { end: 'done' } } }]
      : [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] };
  const executor: WorkflowNodeExecutor = { validate() {}, contract: () => contract,
    contractDefinition: id => files ? { kind: 'files', id, definition: { rules: [], maxFiles: 0, maxTotalBytes: 0, unmatched: 'reject' }, jsonContracts: {} } : { kind: 'json', id, schema: true },
    executionDefinition: async () => ({ schema: 'test-installed/v1' }), check: () => [],
    checkpointValue: async value => {
      if (mode === 'archive-cancel' && value === 1) queueMicrotask(() => queueMicrotask(() => { cancellations.push(runtime.cancelPersisted('run')); }));
      return { schema: 'test-file-value/v1', value };
    },
    restoreValue: async request => { const r = consumeWorkflowValueRestore(request); return { value: r.record.value, dispose: async () => {} }; },
    execute: async (c, input, identity) => {
      calls++;
      if (mode === 'cancel') { await runtime.cancelPersisted('run'); return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: (input as number) + 1 }; }
      if (mode === 'failed' || mode === 'unknown') return { identity, componentId: c.id, status: 'failed', code: 'TEST_FAILURE', stopped: mode === 'failed', issues: [] };
      return { identity, componentId: c.id, status: 'accepted', outcome: 'ok', output: (input as number) + 1 };
    } };
  customize?.(executor);
  const compiled = compileWorkflow(definition, { resolve: id => ({ component: { id, kind: 'transform', inputContract: 'value', outcomes: { ok: 'value' }, implementation: id }, executor }) });
  await (await runtime.startPersisted(compiled, 'run', 0, store)).completion;
  await Promise.all(cancellations);
  return { store, compiled, calls: () => calls };
}
for (const mode of ['normal', 'cancel', 'archive-cancel', 'failed', 'unknown', 'limit', 'max']) test(`loader accepts actual writer states without execution or state writes: ${mode}`, async () => {
  const f = await generated(mode, mode === 'archive-cancel'), calls = f.calls(), records = structuredClone(f.store.records);
  for (const record of records) {
    const reader = { read: async () => structuredClone(record) } as Pick<RunRecordStore, 'read'>;
    const loaded = await loadWorkflowCheckpoint(f.compiled, 'run', reader);
    assert.deepEqual(loaded.checkpoint, record.content); assert.equal(loaded.revision, record.revision);
    (loaded.checkpoint as any).snapshot.runId = 'changed'; assert.equal(loaded.checkpoint.snapshot.runId, 'run');
    await loaded.dispose(); await loaded.dispose();
  }
  assert.equal(f.calls(), calls); assert.deepEqual(f.store.records, records);
});

test('checkpoint schema, identities, values, routing and saved execution drift fail before restore ports', async () => {
  let restored = 0;
  const f = await generated('normal', true, e => { e.restoreValue = async request => { restored++; const r = consumeWorkflowValueRestore(request); return { value: r.record.value, dispose: async () => {} }; }; });
  const original = (await f.store.read())!;
  const mutate: ((c: any) => void)[] = [
    c => { c.schema = 'unknown'; }, c => { c.extra = true; }, c => { c.snapshot.runId = 'other'; }, c => { c.snapshot.workflowId = 'other'; },
    c => { c.snapshot.steps[0].result.identity.attemptNumber = 2; }, c => { c.snapshot.steps[0].node = 'b'; },
    c => { c.snapshot.lastAccepted = null; }, c => { c.cursor.value = 999; }, c => { c.cursor.traversals['["a","ok"]'] = 99; },
    c => { c.values.pop(); }, c => { c.values[1].contract.id = 'different'; }, c => { c.values[1].node = 'b'; },
    c => { c.snapshot.outcome = 'other'; }, c => { c.snapshot.limits.push({ node: 'a' }); },
    c => { c.execution.bindings.a = { schema: 'changed' }; }, c => { c.snapshot.status = 'running'; }
  ];
  for (const mutation of mutate) {
    const record = structuredClone(original); mutation(record.content);
    await assert.rejects(loadWorkflowCheckpoint(f.compiled, 'run', { read: async () => record } as Pick<RunRecordStore, 'read'>), /CHECKPOINT|EXECUTION_MISMATCH/);
  }
  let evaluated = false;
  await assert.rejects(loadWorkflowCheckpoint(f.compiled, 'run', { read: async () => ({ get runId() { evaluated = true; return 'run'; }, revision: 1, content: null }) } as Pick<RunRecordStore, 'read'>), /INVALID_WORKFLOW_CHECKPOINT/);
  assert.equal(evaluated, false); assert.equal(restored, 0);
});

test('JSON saved value mismatch and missing file restoration capabilities reject without installing values', async () => {
  const json = await generated(), record = (await json.store.read())!; (record.content as any).values[0].saved.value = 4;
  await assert.rejects(loadWorkflowCheckpoint(json.compiled, 'run', { read: async () => record } as Pick<RunRecordStore, 'read'>), /INVALID_WORKFLOW_CHECKPOINT/);
  const files = await generated('normal', true, e => { delete e.restoreValue; });
  await assert.rejects(loadWorkflowCheckpoint(files.compiled, 'run', files.store), /WORKFLOW_VALUE_RESTORE_UNAVAILABLE/);
});

test('loader-issued value requests are one-use and failed hydration rolls back in reverse order', async () => {
  const active = new Set<number>(), removed: number[] = []; let request: WorkflowValueRestoreRequest | undefined;
  const f = await generated('normal', true, e => { e.restoreValue = async r => {
    request = r; const data = consumeWorkflowValueRestore(r), value = data.record.value as number;
    if (value === 2) throw new DefinitionError('injected_restore_failure');
    active.add(value); return { value, dispose: async () => { active.delete(value); removed.push(value); } };
  }; });
  await assert.rejects(loadWorkflowCheckpoint(f.compiled, 'run', f.store), /injected_restore_failure/);
  assert.deepEqual([...active], []); assert.deepEqual(removed, [1, 0]);
  assert.throws(() => consumeWorkflowValueRestore(request!), /UNTRUSTED_WORKFLOW_VALUE_RESTORE/);
  assert.throws(() => consumeWorkflowValueRestore(structuredClone(request!)), /UNTRUSTED_WORKFLOW_VALUE_RESTORE/);
});

test('cleanup failure retains pending cleanup without forgetting resources; retry completes it', async () => {
  const active = new Set<number>(); let fail = true;
  const f = await generated('normal', true, e => { e.restoreValue = async r => {
    const value = consumeWorkflowValueRestore(r).record.value as number;
    if (value === 2) throw new DefinitionError('injected_restore_failure');
    active.add(value); return { value, dispose: async () => { if (fail && value === 1) throw new Error('cleanup'); active.delete(value); } };
  }; });
  let pending: WorkflowRestoreError | undefined;
  try { await loadWorkflowCheckpoint(f.compiled, 'run', f.store); assert.fail(); } catch (error) { assert.ok(error instanceof WorkflowRestoreError); pending = error; }
  assert.deepEqual([...active], [0, 1]); fail = false; await pending!.dispose(); await pending!.dispose(); assert.equal(active.size, 0);
});
