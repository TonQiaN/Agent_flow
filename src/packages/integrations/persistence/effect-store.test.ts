import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteEffectRecordStore } from './effect-store.js';
const worker = fileURLToPath(new URL('../../../tests/fixtures/effect-journal.mjs', import.meta.url));
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-effect-journal-')); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function child(root: string, mode: string, changed = 'no') {
  const process = fork(worker, [root, mode, changed], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; process.stderr!.on('data', chunk => { stderr += chunk; });
  const exited = once(process, 'exit');
  const message = Promise.race([once(process, 'message').then(([m]) => m), exited.then(([code, signal]) => { throw new Error(`${code}/${signal}: ${stderr}`); })]);
  return { process, exited, message };
}
async function writes(root: string): Promise<unknown[]> {
  const text = await readFile(join(root, 'external-writes.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
}
for (const point of ['before-reserve', 'reserved', 'after-effect', 'after-receipt']) test(`durable Effect SIGKILL at ${point} never blindly repeats an uncertain operation`, { timeout: 15000 }, async t => {
  const root = await fixture(t), first = child(root, point); t.after(() => { first.process.kill(); });
  assert.equal((await first.message).point, point); assert.deepEqual(await first.exited, [null, 'SIGKILL']);
  const store = await SqliteEffectRecordStore.open(join(root, 'journal')); let identity;
  try {
    identity = store.identity; const prior = await store.read('operation');
    assert.equal(prior?.revision ?? null, point === 'before-reserve' ? null : point === 'after-receipt' ? 2 : 1);
  } finally { store.close(); }
  const second = child(root, 'run'); t.after(() => { second.process.kill(); });
  const result = await second.message; assert.deepEqual(await second.exited, [0, null]); assert.equal(result.identity, identity);
  if (point === 'before-reserve' || point === 'after-receipt') {
    assert.equal(result.result.status, 'accepted'); assert.equal(result.result.outcome, point === 'before-reserve' ? 'applied' : 'already-applied');
    assert.equal(result.query.state, 'applied');
  } else { assert.equal(result.result.code, 'EFFECT_RESULT_UNKNOWN'); assert.equal(result.result.stopped, false); assert.equal(result.query.state, 'pending'); }
  assert.equal((await writes(root)).length, point === 'reserved' ? 0 : 1);
});

test('fresh processes share one logical key, refuse changed input and never double-apply under contention', { timeout: 15000 }, async t => {
  const root = await fixture(t), peers = [child(root, 'run'), child(root, 'run')]; t.after(() => { for (const p of peers) p.process.kill(); });
  const results = await Promise.all(peers.map(p => p.message)); await Promise.all(peers.map(async p => assert.deepEqual(await p.exited, [0, null])));
  assert.equal(results.filter(r => r.result.outcome === 'applied').length, 1); assert.equal(results[0].identity, results[1].identity);
  assert.equal((await writes(root)).length, 1);
  const conflict = child(root, 'run', 'changed'); t.after(() => { conflict.process.kill(); });
  assert.equal((await conflict.message).result.code, 'EFFECT_KEY_CONFLICT'); assert.deepEqual(await conflict.exited, [0, null]); assert.equal((await writes(root)).length, 1);
  const replay = child(root, 'run'); t.after(() => { replay.process.kill(); });
  assert.equal((await replay.message).result.outcome, 'already-applied'); assert.deepEqual(await replay.exited, [0, null]); assert.equal((await writes(root)).length, 1);
});

test('journal namespace survives reopening, new stores differ, CAS and key encoding preserve storage integrity', async t => {
  const root = await fixture(t), first = await SqliteEffectRecordStore.open(join(root, 'one')), second = await SqliteEffectRecordStore.open(join(root, 'two'));
  const identity = first.identity;
  try {
    assert.notEqual(identity, second.identity); const row = await first.create('identity', { data: 1 });
    assert.equal(row.key, 'identity'); assert.equal(row.revision, 1);
    await assert.rejects(first.create('identity', {}), /RUN_ALREADY_EXISTS/);
    await assert.rejects(first.compareAndSwap('identity', 2, {}), /RUN_REVISION_CONFLICT/);
    assert.deepEqual((await first.read('identity'))!.content, { data: 1 });
  } finally { first.close(); second.close(); }
  const reopened = await SqliteEffectRecordStore.open(join(root, 'one')); try { assert.equal(reopened.identity, identity); } finally { reopened.close(); }
});
