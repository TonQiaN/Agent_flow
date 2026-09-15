import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { FileCredentialStore } from './file-store.js';
const identity = { credentialRef: 'shared', service: 'test', method: 'subscription' };
const codec = { service: 'test', method: 'subscription', validate: (text: string) => text.startsWith('fixture-'), validateRefresh: () => false };

test('management reserves an unconfigured identity and excludes execution, replacement, deletion and another login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-management-'));
  try {
    const store = new FileCredentialStore(root, [codec]), options = { ...identity };
    const pending = store.acquireManagement(options); options.credentialRef = 'mutated'; const lease = await pending;
    assert.equal(lease.metadata, null);
    await assert.rejects(store.acquireManagement(identity), /CREDENTIAL_BUSY/);
    await assert.rejects(store.acquire(identity), /CREDENTIAL_BUSY/);
    await assert.rejects(store.configure(identity, { content: 'fixture-competing' }), /CREDENTIAL_BUSY/);
    await assert.rejects(store.delete(identity), /CREDENTIAL_BUSY/);
    const first = await lease.configure('fixture-first-login'); assert.equal(first.revision, 1);
    const results = await Promise.all([lease.configure('fixture-second-login'), lease.configure('fixture-third-login')]);
    assert.deepEqual(results.map(item => item.revision), [2, 3]); assert.equal(first.generation, results[1]!.generation);
    assert.ok(!JSON.stringify(lease).includes('fixture-')); await lease.release(); await lease.release();
    await assert.rejects(lease.configure('fixture-stale'), /CREDENTIAL_LEASE_RELEASED/);
    const execution = await store.acquire(identity);
    try { assert.equal(await execution.readSecret(), 'fixture-third-login'); await assert.rejects(execution.commitSecret('fixture-different-login', 3), /CREDENTIAL_REFRESH_REJECTED/); }
    finally { await execution.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('management invalid input preserves records; original generation/revision and absent state fence external changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-management-fence-'));
  try {
    const store = new FileCredentialStore(root, [codec]);
    await store.configure(identity, { content: 'fixture-original' });
    const path = join(root, 'shared.json'), original = JSON.parse(await readFile(path, 'utf8'));
    const lease = await store.acquireManagement(identity);
    try {
      await assert.rejects(lease.configure('invalid-value'), /INVALID_CREDENTIAL_CONTENT/);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
      await writeFile(path, JSON.stringify({ ...original, revision: 2, payload: 'fixture-external' }));
      await assert.rejects(lease.configure('fixture-old-login'), /CREDENTIAL_REVISION_CONFLICT/);
      await writeFile(path, JSON.stringify({ ...original, generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
      await assert.rejects(lease.configure('fixture-old-login'), /CREDENTIAL_REVISION_CONFLICT/);
    } finally { await lease.release(); }
    await store.delete(identity);
    const absent = await store.acquireManagement(identity);
    try { await writeFile(path, JSON.stringify(original), { mode: 0o600 }); await assert.rejects(absent.configure('fixture-old-empty-state'), /CREDENTIAL_REVISION_CONFLICT/); }
    finally { await absent.release(); }
    await writeFile(path, 'corrupt'); await assert.rejects(store.acquireManagement(identity), /CORRUPT_CREDENTIAL_RECORD/);
    // A failed read must release its lock; this fixture repairs only its own synthetic file.
    await writeFile(path, JSON.stringify(original)); const after = await store.acquireManagement(identity); await after.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real login-management process reserves an absent identity and a crashed holder is not reclaimed', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-management-process-'));
  const child = fork(resolve('src/tests/fixtures/credential-worker.mjs'), [root, '100', 'management'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    assert.equal((await once(child, 'message'))[0].state, 'starting');
    const held = (await once(child, 'message'))[0]; assert.equal(held.state, 'held'); assert.equal(held.metadata, null);
    const store = new FileCredentialStore(root, [codec]);
    await assert.rejects(store.configure(identity, { content: 'fixture-other-process' }), /CREDENTIAL_BUSY/);
    await assert.rejects(store.acquire(identity, 50), /CREDENTIAL_BUSY/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await assert.rejects(store.acquireManagement(identity, 50), /CREDENTIAL_BUSY/);
    assert.equal(await store.inspect(identity), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
