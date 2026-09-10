import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CredentialStore, RunnerResult } from '@agentflow/engine';
import { FileCredentialStore } from './file-store.js';
import { FileExecutionCredentialBinding } from './execution-binding.js';
import { stateEnvironment } from '../execution/state-binding.js';

const identity = { runId: 'binding', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 };
const credential = { credentialRef: 'shared', service: 'fixture', method: 'subscription' };
const codec = { service: 'fixture', method: 'subscription', validate: (s: string) => s.startsWith('fixture-') };
function proof(patch: Partial<RunnerResult> = {}): RunnerResult {
  return { identity, resource: { id: 'resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', capture: null,
    diagnostics: [], startedAt: 0, finishedAt: 1, ...patch };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'af-binding-')); const state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
  const store = new FileCredentialStore(join(root, 'store'), [codec]); await store.configure(credential, { content: 'fixture-original' });
  const binding = await FileExecutionCredentialBinding.acquire(store, { identity, credential, stateFile: 'harness/auth.json', environment: { HARNESS_HOME: '/task/state/harness' } });
  return { root, state, store, binding, copy: join(state, 'harness/auth.json'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('binding holds one lease, keeps sources out of JSON and only commits after confirmed cleanup', async () => {
  const f = await fixture();
  try {
    await f.binding.prepare({ id: 'resource' }, f.state);
    assert.equal(await readFile(f.copy, 'utf8'), 'fixture-original'); assert.equal((await stat(f.copy)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(f.binding).includes('fixture-original')); assert.ok(!JSON.stringify(f.binding).includes(f.root));
    await writeFile(f.copy, 'fixture-refreshed');
    for (const p of [proof({ stop: 'unknown', cleanup: 'blocked' }), proof({ cleanup: 'failed' })]) {
      assert.equal((await f.binding.finish(p)).status, 'retained'); assert.equal((await f.store.inspect(credential))!.revision, 1);
      await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/);
    }
    const result = await f.binding.finish(proof({ phase: 'cancelled', exitCode: null }));
    assert.equal(result.status, 'released'); assert.equal(result.refresh, 'updated'); assert.equal(result.credential.revision, 2);
    await assert.rejects(readFile(f.copy), { code: 'ENOENT' });
    const lease = await f.store.acquire(credential); assert.equal(await lease.readSecret(), 'fixture-refreshed'); await lease.release();
    assert.deepEqual(await f.binding.finish(proof()), result);
    await assert.rejects(f.binding.prepare({ id: 'second' }, f.state), /BINDING_ALREADY_USED/);
  } finally { await f.cleanup(); }
});

test('identity/resource mismatches cannot release a live binding; abandon works only before preparation', async () => {
  const f = await fixture();
  try {
    await f.binding.prepare({ id: 'resource' }, f.state);
    await assert.rejects(f.binding.finish(proof({ identity: { ...identity, attemptId: 'other' } })), /BINDING_EXECUTION_MISMATCH/);
    await assert.rejects(f.binding.finish(proof({ resource: { id: 'other' } })), /BINDING_EXECUTION_MISMATCH/);
    await assert.rejects(f.binding.abandon(), /EXECUTION_PROOF_REQUIRED/);
    await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/);
    assert.equal((await f.binding.finish(proof())).refresh, 'unchanged');
    const second = await FileExecutionCredentialBinding.acquire(f.store, { identity, credential, stateFile: 'auth', environment: {} });
    await second.abandon(); await second.abandon(); await assert.rejects(second.prepare({ id: 'later' }, f.state), /BINDING_ALREADY_USED/);
  } finally { await f.cleanup(); }
});

test('invalid, missing, linked or shared refreshed files do not overwrite the source; cleanup does not follow a link', async () => {
  for (const mode of ['invalid', 'missing', 'symlink', 'hardlink'] as const) {
    const f = await fixture();
    try {
      await f.binding.prepare({ id: 'resource' }, f.state);
      const outside = join(f.root, 'outside'); await writeFile(outside, 'fixture-outside', { mode: 0o600 });
      if (mode === 'invalid') await writeFile(f.copy, 'invalid-synthetic');
      else { await rm(f.copy); if (mode === 'symlink') await symlink(outside, f.copy); if (mode === 'hardlink') await link(outside, f.copy); }
      const result = await f.binding.finish(proof({ exitCode: 1 }));
      assert.equal(result.status, 'released'); assert.equal(result.refresh, 'failed'); assert.deepEqual(result.diagnostics, ['CREDENTIAL_REFRESH_FAILED']);
      assert.equal((await f.store.inspect(credential))!.revision, 1); assert.equal(await readFile(outside, 'utf8'), 'fixture-outside');
      await assert.rejects(readFile(f.copy), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});

test('unsafe copy parents retain the lease without touching the destination and can be retried after repair', async () => {
  const f = await fixture();
  try {
    await f.binding.prepare({ id: 'resource' }, f.state);
    const original = join(f.state, 'harness'); const moved = join(f.state, 'preserved'); const outside = join(f.root, 'other');
    await mkdir(outside, { mode: 0o700 }); await writeFile(join(outside, 'auth.json'), 'fixture-outside', { mode: 0o600 });
    await rename(original, moved); await symlink(outside, original);
    assert.deepEqual((await f.binding.finish(proof())).diagnostics, ['CREDENTIAL_COPY_PARENT_UNSAFE']);
    await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/);
    assert.equal(await readFile(join(outside, 'auth.json'), 'utf8'), 'fixture-outside');
    await rm(original); await rename(moved, original);
    assert.equal((await f.binding.finish(proof())).status, 'released');
  } finally { await f.cleanup(); }
});

test('failed initialization releases on actual cleanup without deleting a pre-existing unowned file', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.state, 'harness'), { mode: 0o700 }); await writeFile(f.copy, 'fixture-unowned', { mode: 0o600 });
    await assert.rejects(f.binding.prepare({ id: 'resource' }, f.state), /CREDENTIAL_PREPARATION_FAILED/);
    const result = await f.binding.finish(proof({ phase: 'failed', exitCode: null }));
    assert.equal(result.status, 'released'); assert.equal(result.refresh, 'not_prepared');
    assert.equal(await readFile(f.copy, 'utf8'), 'fixture-unowned');
  } finally { await f.cleanup(); }
});

test('state path environment rejects escaping or reserved overrides and snapshots caller configuration', () => {
  for (const env of [{ HOME: '/task/state/harness' }, { HTTPS_PROXY: '/task/state/proxy' }, { HARNESS_HOME: '/host/secret' }, { HARNESS_HOME: '/task/state/../input' }, { AGENTFLOW_OUTPUTS: '/task/state/output' }]) {
    assert.throws(() => stateEnvironment(env), /INVALID_STATE_ENVIRONMENT/);
  }
  const env = { HARNESS_HOME: '/task/state/harness' }; const snapshot = stateEnvironment(env); env.HARNESS_HOME = '/changed';
  assert.equal(snapshot['HARNESS_HOME'], '/task/state/harness'); assert.ok(Object.isFrozen(snapshot));
});

test('cleanup retry after a committed refresh does not replay the old revision; concurrent finish is serialized', async () => {
  const f = await fixture();
  try {
    await f.binding.abandon(); let commits = 0;
    const store: CredentialStore = {
      configure: (...args) => f.store.configure(...args), inspect: (...args) => f.store.inspect(...args), delete: (...args) => f.store.delete(...args),
      acquire: async (...args) => {
        const lease = await f.store.acquire(...args);
        return { get metadata() { return lease.metadata; }, readSecret: () => lease.readSecret(), release: () => lease.release(),
          commitSecret: async (content, revision) => {
            commits++; const updated = await lease.commitSecret(content, revision);
            await rm(f.copy); await mkdir(f.copy); // Inject an unlink failure after the store has committed.
            return updated;
          } };
      },
    };
    const binding = await FileExecutionCredentialBinding.acquire(store, { identity, credential, stateFile: 'harness/auth.json', environment: {} });
    await binding.prepare({ id: 'resource' }, f.state); await writeFile(f.copy, 'fixture-new');
    const retained = await binding.finish(proof());
    assert.equal(retained.status, 'retained'); assert.equal(retained.refresh, 'updated'); assert.deepEqual(retained.diagnostics, ['CREDENTIAL_COPY_CLEANUP_FAILED']);
    await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/); assert.equal((await f.store.inspect(credential))!.revision, 2);
    await rm(f.copy, { recursive: true });
    const [first, second] = await Promise.all([binding.finish(proof()), binding.finish(proof())]);
    assert.equal(first.status, 'released'); assert.deepEqual(second, first); assert.equal(commits, 1);
    const lease = await f.store.acquire(credential); assert.equal(await lease.readSecret(), 'fixture-new'); await lease.release();
  } finally { await f.cleanup(); }
});
