import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime } from '@agentflow/engine';
import { createWorkflowRecorder, projectRun } from './views.js';
import { ExecutionLogCapture } from './logs.js';
import type { ExecutionEvent } from './logs.js';

async function storage(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-history-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('committed history survives reopen, paginates without duplicates and excludes losing CAS writes', async t => {
  const root = await storage(t); let store = await SqliteRunRecordStore.open(root);
  await store.create('a', { config: 'old', state: 'queued' });
  await store.compareAndSwap('a', 1, { config: 'old', state: 'running' });
  await assert.rejects(store.commitRecords([{ runId: 'a', revision: 1 }, { runId: 'b', revision: null }], [{ runId: 'b', content: 'phantom' }, { runId: 'a', content: 'lost' }]), /RUN_REVISION_CONFLICT/);
  assert.equal(await store.read('b'), null);
  const first = await store.history('a', 0, 1), second = await store.history('a', first[0]!.sequence, 1);
  assert.equal(first[0]!.revision, 1); assert.equal(second[0]!.revision, 2);
  assert.ok(first[0]!.recordedAt); assert.ok(second[0]!.sequence > first[0]!.sequence);
  await store.appendEvent('a', { type: 'message', text: 'saved' });
  store.close(); store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  assert.equal((await store.history('a')).length, 2); assert.equal((await store.events('a')).length, 1);
  assert.equal((await store.list()).length, 1); assert.deepEqual(await store.list({ after: 'a' }), []);
});
test('v1 migration retains only the known latest revision with unknown time', async t => {
  const root = await storage(t); let store = await SqliteRunRecordStore.open(root);
  await store.create('legacy', 1); await store.compareAndSwap('legacy', 1, 2); store.close();
  const db = new DatabaseSync(join(root, 'runs.sqlite'));
  db.exec('DROP TABLE run_history; DROP TABLE run_events; PRAGMA user_version=1'); db.close();
  store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  const rows = await store.history('legacy'); assert.equal(rows.length, 1); assert.equal(rows[0]!.recordedAt, null); assert.equal(rows[0]!.revision, 2);
  await store.compareAndSwap('legacy', 2, 3);
  assert.deepEqual((await store.history('legacy')).map(r => r.content), [2, 3]);
});
test('a real legacy run records queued, node input, output and immutable settings; view reads never execute', async t => {
  const root = await storage(t), records = await SqliteRunRecordStore.open(root); t.after(() => records.close());
  const contracts = new ContractRegistry(); contracts.register('number', { type: 'number' });
  const components = new ComponentRegistry(contracts), functions = new FunctionRegistry(); let calls = 0;
  components.register({ id: 'inc', implementation: 'inc', kind: 'transform', inputContract: 'number', outcomes: { ok: 'number' } });
  functions.registerDeterministic('inc', { revision: 'v1', run: (input, config) => { calls++; return { outcome: 'ok', output: Number(input) + Number(config) }; } }, 1);
  const compiled = compileWorkflow({ id: 'test', start: 'inc', input: { kind: 'json', id: 'number' }, outcomes: { done: { kind: 'json', id: 'number' } }, maxSteps: 1, nodes: { inc: { component: 'inc' } }, routes: [{ from: 'inc', outcome: 'ok', to: { end: 'done' } }] }, new JsonFunctionWorkflowCatalog(contracts, components, functions));
  const observer = await createWorkflowRecorder(records, compiled, { title: 'Run', entrypoint: 'test' });
  const result = await new WorkflowRuntime(undefined, observer).start(compiled, 'run', 2).completion;
  assert.equal(result.status, 'succeeded'); assert.equal(calls, 1);
  const history = (await records.history('run')).map(projectRun); assert.deepEqual(history.map(r => r!.snapshot.status), ['queued', 'running', 'succeeded']);
  assert.equal(history.at(-1)!.values.length, 2); assert.equal(calls, 1);
  assert.equal(projectRun({ runId: 'private', revision: 1, content: { schema: 'agentflow-node-queue/v3', token: 'private' } }), null);
});
test('stream logs preserve split UTF-8 and nested tool data while redacting credentials across chunks', async () => {
  const events: ExecutionEvent[] = [];
  const secret = 'a-private-secret';
  const capture = new ExecutionLogCapture({ runId: 'r', nodeTaskId: 'n', attemptId: 'a', attemptNumber: 1 }, async event => { events.push(event); }, text => text.split(secret).join('[redacted]'));
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', text: '中文 ' + secret, tool: { arguments: { query: 'evidence' } }, access_token: secret }) + '\n');
  for (let i = 0; i < bytes.length; i += 2) capture.output('stdout', bytes.subarray(i, i + 2));
  capture.close(); assert.deepEqual(await capture.finish(), { complete: true, truncated: false, failed: false });
  const saved = JSON.stringify(events); assert.ok(saved.includes('中文')); assert.ok(saved.includes('evidence')); assert.ok(!saved.includes(secret)); assert.ok(!saved.includes('access_token')); assert.ok(events[0]!.receivedAt);
  const limited = new ExecutionLogCapture(events[0]!.identity, async e => { events.push(e); }, x => x, 2);
  limited.output('stderr', Buffer.from('long\n')); limited.close(); assert.equal((await limited.finish()).truncated, true);
  const failing = new ExecutionLogCapture(events[0]!.identity, async () => { throw new Error('disk'); }, x => x);
  failing.output('stdout', Buffer.from('line\n')); failing.close(); assert.equal((await failing.finish()).failed, true);
});
