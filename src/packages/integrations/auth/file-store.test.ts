import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { FileCredentialStore } from './file-store.js';
import type { CredentialSource } from '@agentflow/engine';

const identity = { credentialRef: 'shared', service: 'test', method: 'subscription' };
const codec = { service: 'test', method: 'subscription', validate: (value: string): boolean => value.startsWith('fixture-') };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'af-credential-test-'));
  const root = join(directory, 'store');
  return { directory, root, store: new FileCredentialStore(root, [codec]), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('explicit sources, private files and local-only status; no ambient credential fallback', async () => {
  const fixture = await setup();
  try {
    process.env['AGENTFLOW_TEST_AMBIENT_KEY'] = 'fixture-wrong-ambient';
    assert.equal(await fixture.store.inspect(identity), null);
    await assert.rejects(fixture.store.acquire(identity), /CREDENTIAL_NOT_CONFIGURED/);
    await assert.rejects(fixture.store.configure(identity, { content: 'fixture-secret', file: '/somewhere' } as unknown as CredentialSource), /CONFLICTING_CREDENTIAL_SOURCES/);
    const meta = await fixture.store.configure(identity, { content: 'fixture-secret' });
    assert.equal(meta.remoteStatus, 'unknown');
    assert.equal(meta.revision, 1);
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(fixture.root, 'shared.json'))).mode & 0o777, 0o600);
    const lease = await fixture.store.acquire(identity);
    assert.equal(await lease.readSecret(), 'fixture-secret');
    assert.ok(!JSON.stringify(lease).includes('fixture-secret'));
    assert.deepEqual(JSON.parse(JSON.stringify(lease)), meta);
    await lease.release();
    await lease.release();
    await assert.rejects(lease.readSecret(), /CREDENTIAL_LEASE_RELEASED/);
    const source = join(fixture.directory, 'source'); await writeFile(source, 'fixture-from-file', { mode: 0o600 });
    assert.equal((await fixture.store.configure(identity, { file: source })).revision, 2);
    assert.deepEqual(await fixture.store.delete(identity), { deleted: true, remoteRevoked: false });
    assert.equal(await fixture.store.inspect(identity), null);
    assert.deepEqual(await fixture.store.delete(identity), { deleted: false, remoteRevoked: false });
  } finally { delete process.env['AGENTFLOW_TEST_AMBIENT_KEY']; await fixture.cleanup(); }
});

test('source, root and saved record safety checks reject unsafe permissions, links and mismatched identities', async () => {
  const fixture = await setup();
  try {
    const source = join(fixture.directory, 'source'); await writeFile(source, 'fixture-secret', { mode: 0o644 });
    await assert.rejects(fixture.store.configure(identity, { file: source }), /UNSAFE_CREDENTIAL_FILE/);
    await chmod(source, 0o600);
    const symbolic = join(fixture.directory, 'symbolic'); await symlink(source, symbolic);
    await assert.rejects(fixture.store.configure(identity, { file: symbolic }), /UNSAFE_CREDENTIAL_FILE/);
    const hard = join(fixture.directory, 'hard'); await link(source, hard);
    await assert.rejects(fixture.store.configure(identity, { file: hard }), /UNSAFE_CREDENTIAL_FILE/);
    await rm(hard);
    await fixture.store.configure(identity, { file: source });
    const saved = join(fixture.root, 'shared.json');
    const record = JSON.parse(await readFile(saved, 'utf8'));
    await writeFile(saved, JSON.stringify({ ...record, service: 'other' }));
    await assert.rejects(fixture.store.inspect(identity), /CREDENTIAL_IDENTITY_MISMATCH/);
    await writeFile(saved, JSON.stringify(record));
    await chmod(saved, 0o640);
    await assert.rejects(fixture.store.inspect(identity), /UNSAFE_CREDENTIAL_FILE/);
    await chmod(fixture.root, 0o755);
    await assert.rejects(fixture.store.inspect(identity), /UNSAFE_CREDENTIAL_DIRECTORY/);
    await chmod(fixture.root, 0o700);
    const linkedRoot = join(fixture.directory, 'linked'); await symlink(fixture.root, linkedRoot);
    await assert.rejects(new FileCredentialStore(linkedRoot, [codec]).inspect(identity), /UNSAFE_CREDENTIAL_DIRECTORY/);
  } finally { await fixture.cleanup(); }
});

test('refresh requires the original revision; malformed updates preserve the last valid credential', async () => {
  const fixture = await setup();
  try {
    await fixture.store.configure(identity, { content: 'fixture-original' });
    const lease = await fixture.store.acquire(identity);
    try {
      await assert.rejects(lease.commitSecret('invalid-secret-value', 1), /INVALID_CREDENTIAL_CONTENT/);
      assert.equal(await lease.readSecret(), 'fixture-original');
      const updated = await lease.commitSecret('fixture-refreshed', 1);
      assert.equal(updated.revision, 2);
      await assert.rejects(lease.commitSecret('fixture-stale', 1), /CREDENTIAL_REVISION_CONFLICT/);
      assert.equal(await lease.readSecret(), 'fixture-refreshed');
      assert.equal((await lease.commitSecret('fixture-refreshed', 2)).revision, 2);
      const [first, stale] = await Promise.allSettled([lease.commitSecret('fixture-next', 2), lease.commitSecret('fixture-concurrent-old', 2)]);
      assert.equal(first.status, 'fulfilled'); assert.equal(stale.status, 'rejected');
      assert.equal(await lease.readSecret(), 'fixture-next');
    } finally { await lease.release(); }
    const reopened = await new FileCredentialStore(fixture.root, [codec]).acquire(identity);
    assert.equal(await reopened.readSecret(), 'fixture-next'); await reopened.release();
  } finally { await fixture.cleanup(); }
});

test('external revision or generation change fences stale refresh instead of overwriting it', async () => {
  const fixture = await setup();
  try {
    await fixture.store.configure(identity, { content: 'fixture-original' });
    const lease = await fixture.store.acquire(identity);
    try {
      const saved = join(fixture.root, 'shared.json'); const record = JSON.parse(await readFile(saved, 'utf8'));
      await writeFile(saved, JSON.stringify({ ...record, revision: 2, payload: 'fixture-external' }));
      await assert.rejects(lease.commitSecret('fixture-old-copy', 1), /CREDENTIAL_REVISION_CONFLICT/);
      assert.equal(JSON.parse(await readFile(saved, 'utf8')).payload, 'fixture-external');
      await writeFile(saved, JSON.stringify({ ...record, generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
      await assert.rejects(lease.commitSecret('fixture-old-copy', 1), /CREDENTIAL_REVISION_CONFLICT/);
    } finally { await lease.release(); }
  } finally { await fixture.cleanup(); }
});

test('management shares the execution lock; validation errors release locks and never echo secrets', async () => {
  const fixture = await setup();
  try {
    await fixture.store.configure(identity, { content: 'fixture-original' });
    const lease = await fixture.store.acquire(identity);
    await assert.rejects(fixture.store.delete(identity), /CREDENTIAL_BUSY/);
    await assert.rejects(new FileCredentialStore(fixture.root, [codec]).configure(identity, { content: 'fixture-replacement' }), /CREDENTIAL_BUSY/);
    await lease.release();
    assert.equal((await fixture.store.configure(identity, { content: 'fixture-replacement' })).revision, 2);
    const throwing = new FileCredentialStore(join(fixture.directory, 'throwing'), [{ ...codec, validate: value => { throw new Error(value); } }]);
    await assert.rejects(throwing.configure(identity, { content: 'fixture-never-log-this' }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'INVALID_CREDENTIAL_CONTENT');
      assert.ok(!JSON.stringify(error).includes('fixture-never-log-this')); return true;
    });
    await writeFile(join(fixture.root, 'shared.json'), '{ corrupt fixture-private');
    await assert.rejects(fixture.store.acquire(identity), /CORRUPT_CREDENTIAL_RECORD/);
    // Failure before returning a lease releases it. Repair is deliberately an explicit host action here.
    await rm(join(fixture.root, 'shared.json'));
    await fixture.store.configure(identity, { content: 'fixture-reconfigured' });
    const after = await fixture.store.acquire(identity); await after.release();
  } finally { await fixture.cleanup(); }
});

test('real processes serialize the same credentialRef, wait, and retain a crashed holder lock', { timeout: 15_000 }, async () => {
  const fixture = await setup();
  const children: ReturnType<typeof fork>[] = [];
  const child = (wait: number) => {
    const worker = fork(resolve('src/tests/fixtures/credential-worker.mjs'), [fixture.root, String(wait)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(worker); return worker;
  };
  try {
    await fixture.store.configure(identity, { content: 'fixture-cross-process' });
    const held = await fixture.store.acquire(identity);
    const blocked = child(100);
    assert.equal((await once(blocked, 'message'))[0].state, 'starting');
    const failure = (await once(blocked, 'message'))[0];
    assert.deepEqual(failure, { state: 'failed', code: 'CREDENTIAL_BUSY' });
    const waiting = child(5000);
    assert.equal((await once(waiting, 'message'))[0].state, 'starting');
    const acquired = once(waiting, 'message');
    await held.release();
    assert.equal((await acquired)[0].state, 'held');
    await assert.rejects(fixture.store.acquire(identity), /CREDENTIAL_BUSY/);
    const exited = once(waiting, 'exit'); waiting.send('release'); await exited;
    const crashed = child(1000);
    assert.equal((await once(crashed, 'message'))[0].state, 'starting');
    assert.equal((await once(crashed, 'message'))[0].state, 'held');
    const died = once(crashed, 'exit'); crashed.kill('SIGKILL'); await died;
    await assert.rejects(fixture.store.acquire(identity, 100), /CREDENTIAL_BUSY/);
    assert.equal((await fixture.store.inspect(identity))?.remoteStatus, 'unknown');
  } finally { for (const worker of children) if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await fixture.cleanup(); }
});

test('deleted credentials do not reappear and recreated identity has a new generation', async () => {
  const fixture = await setup();
  try {
    const original = await fixture.store.configure(identity, { content: 'fixture-original' });
    await fixture.store.delete(identity);
    assert.equal(await fixture.store.inspect(identity), null);
    await assert.rejects(fixture.store.acquire(identity), /CREDENTIAL_NOT_CONFIGURED/);
    const recreated = await fixture.store.configure(identity, { content: 'fixture-new-login' });
    assert.notEqual(original.generation, recreated.generation);
    assert.equal(recreated.revision, 1);
    // Unknown stale lock formats never trigger automatic recovery.
    await mkdir(join(fixture.root, 'shared.lock'), { mode: 0o700 });
    await assert.rejects(fixture.store.acquire(identity), /CREDENTIAL_BUSY/);
  } finally { await fixture.cleanup(); }
});
