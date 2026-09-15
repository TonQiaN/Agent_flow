import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat, writeFile, symlink, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '@agentflow/domain';
import { SqliteRunRecordStore } from './sqlite-store.js';

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-run-store-')); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const worker = fileURLToPath(new URL('../../../tests/fixtures/run-store-worker.mjs', import.meta.url));
function child(root: string, mode: string, value: string) {
  const process = fork(worker, [root, mode, value], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  process.stdout!.resume(); process.stderr!.resume();
  const exited = once(process, 'exit'), ready = once(process, 'message');
  return { process, exited, ready };
}

test('SQLite run records persist snapshots across reopen and enforce version conflicts without losing content', async t => {
  const root = await directory(t); let store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  assert.equal(await store.read('missing'), null);
  const input = { definition: { id: 'workflow' }, state: { attempts: [{ id: 'a', outcome: 'accepted' }] } };
  const first = await store.create('run', input); input.state.attempts[0]!.outcome = 'tampered';
  (first.content as any).definition.id = 'tampered';
  assert.deepEqual(await store.read('run'), { runId: 'run', revision: 1, content: { definition: { id: 'workflow' }, state: { attempts: [{ id: 'a', outcome: 'accepted' }] } } });
  await assert.rejects(store.create('run', null), { code: 'RUN_ALREADY_EXISTS' });
  const second = await store.compareAndSwap('run', 1, { saved: true }); assert.equal(second.revision, 2);
  await assert.rejects(store.compareAndSwap('run', 1, { overwritten: true }), { code: 'RUN_REVISION_CONFLICT' });
  await assert.rejects(store.compareAndSwap('missing', 1, null), { code: 'RUN_NOT_FOUND' });
  store.close(); store.close(); await assert.rejects(store.read('run'), { code: 'RUN_STORE_CLOSED' });
  store = await SqliteRunRecordStore.open(root); assert.deepEqual(await store.read('run'), second);
  assert.equal((await stat(root)).mode & 0o077, 0); assert.equal((await stat(join(root, 'runs.sqlite'))).mode & 0o777, 0o600);
  const database = new DatabaseSync(join(root, 'runs.sqlite'));
  try { assert.equal(database.prepare('PRAGMA journal_mode').get()!['journal_mode'], 'wal'); } finally { database.close(); }
});

test('SQLite run state rejects non-JSON, oversized input, invalid IDs and unsafe revisions without writing', async t => {
  const root = await directory(t), store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  let evaluated = false; const getter = { get value() { evaluated = true; return 1; } };
  for (const value of [undefined, NaN, { callback() {} }, getter, new Date()]) await assert.rejects(store.create('run', value as JsonValue), { code: 'INVALID_RUN_RECORD' });
  assert.equal(evaluated, false);
  await assert.rejects(store.create('run', 'a'.repeat(16 * 1024 * 1024)), { code: 'RUN_RECORD_TOO_LARGE' });
  await assert.rejects(store.create('run\n', null), { code: 'INVALID_RUN_RECORD' });
  for (const revision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) await assert.rejects(store.compareAndSwap('run', revision, null), { code: 'INVALID_RUN_RECORD' });
  assert.equal(await store.read('run'), null);
});

test('independent processes race one revision: exactly one committed writer and one explicit conflict', { timeout: 30000 }, async t => {
  const root = await directory(t), store = await SqliteRunRecordStore.open(root); t.after(() => store.close()); await store.create('run', { winner: 'original' });
  const a = child(root, 'race', 'a'), b = child(root, 'race', 'b'); t.after(() => { a.process.kill(); b.process.kill(); });
  await Promise.all([a.ready, b.ready]);
  const results = Promise.all([once(a.process, 'message'), once(b.process, 'message')]); a.process.send('go'); b.process.send('go');
  const messages = (await results).map(([message]) => message);
  assert.deepEqual(messages.map(v => v.status).sort(), ['error', 'saved']);
  assert.equal(messages.find(v => v.status === 'error').code, 'RUN_REVISION_CONFLICT');
  assert.deepEqual(await store.read('run'), messages.find(v => v.status === 'saved').record);
  await Promise.all([a.exited, b.exited]);
});

for (const mode of ['before-commit', 'after-commit']) test(`actual writer SIGKILL ${mode} leaves a complete committed revision`, { timeout: 30000 }, async t => {
  const root = await directory(t); let store = await SqliteRunRecordStore.open(root); await store.create('run', { winner: 'original' }); store.close();
  const run = child(root, mode, 'new'); t.after(() => run.process.kill()); await run.ready; run.process.send('go');
  const [code, signal] = await run.exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  assert.deepEqual(await store.read('run'), { runId: 'run', revision: mode === 'before-commit' ? 1 : 2, content: { winner: mode === 'before-commit' ? 'original' : 'new' } });
  const next = await store.compareAndSwap('run', mode === 'before-commit' ? 1 : 2, { recovered: true }); assert.ok(next.revision > 1);
});

test('corrupt payload and unsupported database schema fail closed without repair or loss of old data', async t => {
  const root = await directory(t); let store = await SqliteRunRecordStore.open(root); await store.create('run', { protected: true }); store.close();
  let db = new DatabaseSync(join(root, 'runs.sqlite')); db.prepare('UPDATE run_records SET payload = ? WHERE run_id = ?').run('{broken', 'run'); db.close();
  store = await SqliteRunRecordStore.open(root); await assert.rejects(store.read('run'), { code: 'RUN_STORE_CORRUPT' }); await assert.rejects(store.compareAndSwap('run', 1, null), { code: 'RUN_STORE_CORRUPT' }); store.close();
  db = new DatabaseSync(join(root, 'runs.sqlite')); db.exec('PRAGMA user_version = 999'); db.close();
  await assert.rejects(SqliteRunRecordStore.open(root), { code: 'RUN_STORE_UNSUPPORTED' });
  db = new DatabaseSync(join(root, 'runs.sqlite')); try { assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 999); assert.equal(db.prepare('SELECT payload FROM run_records').get()!['payload'], '{broken'); } finally { db.close(); }
});

test('SQLite store refuses unsafe directories, linked files and unsafe preexisting sidecars', async t => {
  const root = await directory(t);
  const publicRoot = join(root, 'public'); await mkdir(publicRoot, { mode: 0o755 }); await assert.rejects(SqliteRunRecordStore.open(publicRoot), { code: 'RUN_STORE_UNSAFE' });
  const privateRoot = join(root, 'private'); await mkdir(privateRoot, { mode: 0o700 }); const alias = join(root, 'alias'); await symlink(privateRoot, alias);
  await assert.rejects(SqliteRunRecordStore.open(alias), { code: 'RUN_STORE_UNSAFE' });
  const original = join(root, 'original'); await writeFile(original, '', { mode: 0o600 }); await link(original, join(privateRoot, 'runs.sqlite'));
  await assert.rejects(SqliteRunRecordStore.open(privateRoot), { code: 'RUN_STORE_UNSAFE' }); await rm(join(privateRoot, 'runs.sqlite'));
  await symlink(original, join(privateRoot, 'runs.sqlite')); await assert.rejects(SqliteRunRecordStore.open(privateRoot), { code: 'RUN_STORE_UNSAFE' }); await rm(join(privateRoot, 'runs.sqlite'));
  await writeFile(join(privateRoot, 'runs.sqlite-wal'), '', { mode: 0o644 }); await assert.rejects(SqliteRunRecordStore.open(privateRoot), { code: 'RUN_STORE_UNSAFE' });
  await rm(join(privateRoot, 'runs.sqlite-wal')); const store = await SqliteRunRecordStore.open(privateRoot); store.close();
  await chmod(join(privateRoot, 'runs.sqlite'), 0o644); await assert.rejects(SqliteRunRecordStore.open(privateRoot), { code: 'RUN_STORE_UNSAFE' });
});


test('direct replay queries preserve timestamp boundaries, save order and payload integrity', async t => {
  const root = await directory(t), store = await SqliteRunRecordStore.open(root); t.after(() => store.close());
  let now = 10; t.mock.method(Date, 'now', () => now);
  await store.create('replay', { value: 'first' });
  now = 20; await store.compareAndSwap('replay', 1, { value: 'second' });
  await store.compareAndSwap('replay', 2, { value: 'third at same time' });
  assert.equal(await store.revisionAt('replay', 9), null);
  assert.equal((await store.revisionAt('replay', 19))!.revision, 1);
  assert.equal((await store.revisionAt('replay', 20))!.revision, 3);
  assert.equal((await store.revision('replay', 2))!.revision, 2);
  assert.equal(await store.revision('replay', 8), null);
  assert.equal((await store.read('replay'))!.revision, 3);
  await assert.rejects(store.revisionAt('replay', -1), { code: 'INVALID_RUN_RECORD' });
  await assert.rejects(store.revision('replay', 0), { code: 'INVALID_RUN_RECORD' });
  const database = new DatabaseSync(join(root, 'runs.sqlite'));
  database.exec('UPDATE run_history SET recorded_at = NULL WHERE revision = 1');
  assert.equal(await store.revisionAt('replay', 19), null);
  assert.equal((await store.revision('replay', 1))!.recordedAt, null);
  database.exec("UPDATE run_history SET payload = 'null' WHERE revision = 3"); database.close();
  await assert.rejects(store.revisionAt('replay', 20), { code: 'RUN_STORE_CORRUPT' });
});
