import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink, link, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { FileCredentialStore } from './file-store.js';
const identity = { credentialRef: 'shared', service: 'test', method: 'subscription' };
const codec = { service: 'test', method: 'subscription', validate: (x: string) => x.startsWith('fixture-') };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'af-recovery-')); const store = new FileCredentialStore(root, [codec]);
  const live = join(root, 'shared.json'), backup = join(root, '.backup-shared.json');
  const metadata = await store.configure(identity, { content: 'fixture-original-credential' });
  return { root, store, live, backup, metadata, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function tear(path: string): Promise<string> { const original = await readFile(path, 'utf8'); await writeFile(path, original.slice(0, -8)); return original; }

test('backup namespace cannot collide with another valid credential reference', async () => {
  const f = await setup();
  try {
    const other = { ...identity, credentialRef: 'shared.backup' };
    await f.store.configure(other, { content: 'fixture-other-reference' });
    await f.store.configure(identity, { content: 'fixture-updated' });
    const lease = await f.store.acquire(other); assert.equal(await lease.readSecret(), 'fixture-other-reference'); await lease.release();
    await f.store.delete(identity);
    const again = await f.store.acquire(other); assert.equal(await again.readSecret(), 'fixture-other-reference'); await again.release();
  } finally { await f.cleanup(); }
});

test('committed private backup restores only its complete-identity tail prefix without a new revision', async () => {
  const f = await setup();
  try {
    const original = await readFile(f.live, 'utf8'); assert.equal(await readFile(f.backup, 'utf8'), original); assert.equal((await stat(f.backup)).mode & 0o777, 0o600);
    await tear(f.live); await assert.rejects(f.store.acquire(identity), /CORRUPT_CREDENTIAL_RECORD/);
    const result = await f.store.recover(identity); assert.equal(result.status, 'restored'); assert.deepEqual(result.credential, f.metadata);
    assert.ok(!JSON.stringify(result).includes('fixture-')); assert.equal(await readFile(f.live, 'utf8'), original);
    assert.equal((await stat(f.live)).mode & 0o777, 0o600); assert.equal((await f.store.recover(identity)).status, 'healthy');
    const lease = await f.store.acquire(identity); assert.equal(await lease.readSecret(), 'fixture-original-credential'); await lease.release();
  } finally { await f.cleanup(); }
});

test('healthy newer records never roll back; stale revisions and generations cannot repair a torn newer record', async () => {
  const f = await setup();
  try {
    const old = await readFile(f.backup, 'utf8');
    const updated = await f.store.configure(identity, { content: 'fixture-current-credential' }); assert.equal(updated.revision, 2);
    const current = await readFile(f.live, 'utf8'); await writeFile(f.backup, old);
    assert.equal((await f.store.recover(identity)).status, 'healthy'); assert.equal(await readFile(f.live, 'utf8'), current);
    await tear(f.live); const torn = await readFile(f.live, 'utf8');
    assert.equal((await f.store.recover(identity)).status, 'unavailable'); assert.equal(await readFile(f.live, 'utf8'), torn);
    await writeFile(f.live, current); await f.store.delete(identity);
    await f.store.configure(identity, { content: 'fixture-new-login' }); await writeFile(f.backup, old); await tear(f.live);
    assert.equal((await f.store.recover(identity)).status, 'unavailable');
  } finally { await f.cleanup(); }
});

test('deletion removes backup and a missing live credential cannot be resurrected even with a leftover copy', async () => {
  const f = await setup();
  try {
    const backup = await readFile(f.backup, 'utf8'); await f.store.delete(identity); await assert.rejects(access(f.live)); await assert.rejects(access(f.backup));
    await writeFile(f.backup, backup, { mode: 0o600 });
    assert.equal((await f.store.recover(identity)).status, 'not_configured'); await assert.rejects(access(f.live));
    await f.store.delete(identity); await assert.rejects(access(f.backup));
  } finally { await f.cleanup(); }
});

test('unknown schema, unknown bytes, damaged backup, missing backup and truncation before identity all refuse unchanged', async () => {
  const f = await setup();
  try {
    const original = await readFile(f.live, 'utf8');
    for (const bad of ['opaque-format', '\uFEFF' + original.slice(0, -8), '', '{', original.slice(0, original.indexOf('generation')), JSON.stringify({ ...JSON.parse(original), schema: 2 }), JSON.stringify({ ...JSON.parse(original), payload: 'invalid' })]) {
      await writeFile(f.live, bad); assert.equal((await f.store.recover(identity)).status, 'unavailable'); assert.equal(await readFile(f.live, 'utf8'), bad);
    }
    await writeFile(f.live, original); await tear(f.live); const torn = await readFile(f.live, 'utf8');
    await writeFile(f.backup, '{'); assert.equal((await f.store.recover(identity)).diagnostic, 'RECOVERY_BACKUP_INVALID');
    await rm(f.backup); assert.equal((await f.store.recover(identity)).diagnostic, 'RECOVERY_BACKUP_MISSING'); assert.equal(await readFile(f.live, 'utf8'), torn);
    await writeFile(f.backup, original, { mode: 0o600 }); await writeFile(f.live, new Uint8Array([0xff, 0xfe]));
    await assert.rejects(f.store.recover(identity), /INVALID_CREDENTIAL_ENCODING/);
  } finally { await f.cleanup(); }
});

test('unsafe live or backup files, foreign identity and busy leases do not weaken recovery', async () => {
  const f = await setup();
  try {
    const original = await readFile(f.live, 'utf8');
    const lease = await f.store.acquire(identity); await assert.rejects(f.store.recover(identity), /CREDENTIAL_BUSY/); await lease.release();
    const admin = await f.store.acquireManagement(identity); await assert.rejects(f.store.recover(identity), /CREDENTIAL_BUSY/); await admin.release();
    await tear(f.live); await chmod(f.backup, 0o644); await assert.rejects(f.store.recover(identity), /UNSAFE_CREDENTIAL_FILE/); await chmod(f.backup, 0o600);
    const linked = join(f.root, 'linked'); await link(f.backup, linked); await assert.rejects(f.store.recover(identity), /UNSAFE_CREDENTIAL_FILE/); await rm(linked);
    await rm(f.backup); await symlink(f.live, f.backup); await assert.rejects(f.store.recover(identity), /UNSAFE_CREDENTIAL_FILE/);
    await rm(f.backup); await writeFile(f.backup, original, { mode: 0o600 }); await chmod(f.live, 0o644); await assert.rejects(f.store.recover(identity), /UNSAFE_CREDENTIAL_FILE/);
    await chmod(f.live, 0o600); await writeFile(f.live, JSON.stringify({ ...JSON.parse(original), service: 'other' }));
    await assert.rejects(f.store.recover(identity), /CREDENTIAL_IDENTITY_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('unchanged configure and unchanged refresh can checkpoint a valid legacy record without changing version', async () => {
  const f = await setup();
  try {
    const legacy = JSON.parse(await readFile(f.live, 'utf8'));
    await writeFile(f.live, JSON.stringify({ credentialRef: legacy.credentialRef, service: legacy.service, method: legacy.method, schema: 1, generation: legacy.generation, revision: legacy.revision, payload: legacy.payload }));
    await rm(f.backup); assert.deepEqual(await f.store.configure(identity, { content: 'fixture-original-credential' }), f.metadata); assert.equal(await readFile(f.backup, 'utf8'), await readFile(f.live, 'utf8'));
    await rm(f.backup); const lease = await f.store.acquire(identity); assert.deepEqual(await lease.commitSecret('fixture-original-credential', 1), f.metadata); await lease.release(); await access(f.backup);
  } finally { await f.cleanup(); }
});

for (const stage of ['replace-before-live', 'replace-after-live', 'delete-before-live', 'delete-after-live', 'recover-before-live'] as const)
  test(`actual process interruption at ${stage} leaves no stale recovery authority`, async () => {
    const f = await setup();
    try {
      const old = await readFile(f.live, 'utf8'); if (stage === 'recover-before-live') await tear(f.live);
      const child = fork(resolve('src/tests/fixtures/credential-crash.mjs'), [f.root, stage], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const [code, signal] = await once(child, 'exit'); assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      await assert.rejects(f.store.recover(identity), /CREDENTIAL_BUSY/);
      // This fixture writer is a known pure storage subprocess, with no sandbox or external work.
      // Production never removes a lock merely because a PID died.
      await rm(join(f.root, 'shared.lock'), { recursive: true });
      if (stage === 'recover-before-live') {
        assert.equal(await readFile(f.backup, 'utf8'), old); assert.equal((await f.store.recover(identity)).status, 'restored');
      } else {
        await assert.rejects(access(f.backup));
        if (stage === 'delete-after-live') { assert.equal((await f.store.recover(identity)).status, 'not_configured'); await assert.rejects(access(f.live)); }
        else {
          assert.equal((await f.store.recover(identity)).status, 'healthy'); const stored = JSON.parse(await readFile(f.live, 'utf8'));
          assert.equal(stored.payload, stage === 'replace-after-live' ? 'fixture-new-credential' : 'fixture-original-credential');
          assert.equal(stored.revision, stage === 'replace-after-live' ? 2 : 1);
        }
      }
    } finally { await f.cleanup(); }
  });

test('compiled auth recovery reports public local status, refuses unknown content and never echoes stored material', async () => {
  const f = await setup();
  try {
    const cliRoot = join(f.root, 'cli'); const { DeepSeekApiKeyCodec } = await import('./deepseek-api-key.js');
    const store = new FileCredentialStore(cliRoot, [new DeepSeekApiKeyCodec()]); const selected = { credentialRef: 'cli', service: 'deepseek', method: 'api-key' };
    await store.configure(selected, { content: JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-recovery-key' }) });
    const path = join(cliRoot, 'cli.json'); await tear(path);
    const args = [resolve('src/apps/cli/dist/index.js'), 'auth', 'recover', 'deepseek', '--store', cliRoot, '--credential-ref', 'cli'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).status, 'restored'); assert.ok(!JSON.stringify(result).includes('fixture-recovery-key'));
    await writeFile(path, '{}'); const refused = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 }); assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stdout).status, 'unavailable');
  } finally { await f.cleanup(); }
});
