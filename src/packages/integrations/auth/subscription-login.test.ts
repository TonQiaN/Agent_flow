import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerResult } from '@agentflow/engine';
import { FileCredentialStore } from './file-store.js';
import { SubscriptionLoginCoordinator } from './subscription-login.js';
import type { SubscriptionLoginDriver } from './subscription-login.js';
const identity = { runId: 'login', nodeTaskId: 'management', attemptId: 'one', attemptNumber: 1 };
const credential = { credentialRef: 'fixture', service: 'test', method: 'subscription' };
const codec = { service: 'test', method: 'subscription', validate: (text: string) => text.startsWith('fixture-') };
const proof = (patch: Partial<RunnerResult> = {}): RunnerResult => ({ identity, resource: { id: 'login-container' }, phase: 'exited', exitCode: 0,
  stop: 'confirmed', cleanup: 'removed', capture: null, diagnostics: [], startedAt: 1, finishedAt: 2, ...patch });
const driver = (patch: Partial<SubscriptionLoginDriver> = {}): SubscriptionLoginDriver => ({ run: async () => proof(), readCredential: async () => 'fixture-login-value', recover: async () => proof(), release: async () => {}, ...patch });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'af-login-')), store = new FileCredentialStore(root, [codec]);
  return { store, coordinator: new SubscriptionLoginCoordinator(store), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('first login holds management until private material cleanup; result contains local metadata only', async () => {
  const f = await fixture();
  try {
    const attempt = await f.coordinator.run({ identity, credential }, driver({
      run: async () => { await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/); return proof(); },
      release: async () => { await assert.rejects(f.store.delete(credential), /CREDENTIAL_BUSY/); },
    }));
    assert.equal(attempt.result.status, 'configured'); assert.equal(attempt.result.credential!.remoteStatus, 'unknown');
    assert.ok(!JSON.stringify(attempt).includes('fixture-login-value'));
    const view = attempt.result; (view.identity as { runId: string }).runId = 'changed'; assert.equal(attempt.result.identity.runId, 'login');
    const lease = await f.store.acquire(credential); assert.equal(await lease.readSecret(), 'fixture-login-value'); await lease.release();
    await attempt.retryCleanup(); await assert.rejects(attempt.execute(), /LOGIN_ALREADY_STARTED/);
  } finally { await f.cleanup(); }
});

test('failed/cancelled login and invalid output do not replace the prior credential', async () => {
  const f = await fixture();
  try {
    await f.store.configure(credential, { content: 'fixture-prior' });
    for (const patch of [{ run: async () => proof({ exitCode: 1 }) }, { run: async () => proof({ phase: 'cancelled' as const, exitCode: null }) },
      { readCredential: async () => 'invalid-output' }, { readCredential: async () => { throw new Error('fixture-private-error'); } }]) {
      const attempt = await f.coordinator.run({ identity, credential }, driver(patch)); assert.equal(attempt.result.status, 'failed');
      assert.ok(!JSON.stringify(attempt).includes('fixture-private-error'));
      const lease = await f.store.acquire(credential); assert.equal(await lease.readSecret(), 'fixture-prior'); await lease.release();
    }
  } finally { await f.cleanup(); }
});

test('unknown stop retains management; mismatched recovery cannot release or upgrade failed login', async () => {
  const f = await fixture(); let wrong = true, reads = 0;
  try {
    const attempt = await f.coordinator.run({ identity, credential }, driver({ run: async () => proof({ phase: 'failed', exitCode: null, stop: 'unknown', cleanup: 'blocked' }),
      recover: async () => proof({ resource: { id: wrong ? 'another-container' : 'login-container' } }), readCredential: async () => { reads++; return 'fixture-wrong'; } }));
    assert.equal(attempt.result.status, 'pending_cleanup'); await assert.rejects(f.store.delete(credential), /CREDENTIAL_BUSY/);
    await attempt.retryCleanup(); assert.equal(attempt.result.status, 'pending_cleanup');
    wrong = false; await attempt.retryCleanup(); assert.equal(attempt.result.status, 'failed'); assert.equal(reads, 0); assert.equal(await f.store.inspect(credential), null);
    const after = await f.store.acquireManagement(credential); await after.release();
  } finally { await f.cleanup(); }
});

test('private cleanup retry neither re-runs login nor re-saves a committed credential', async () => {
  const f = await fixture(); let runs = 0, reads = 0, failRelease = true;
  try {
    const attempt = await f.coordinator.run({ identity, credential }, driver({ run: async () => { runs++; return proof(); },
      readCredential: async () => { reads++; return 'fixture-completed'; }, release: async () => { if (failRelease) throw new Error('private-value'); } }));
    assert.equal(attempt.result.status, 'pending_cleanup'); assert.equal(attempt.result.credential!.revision, 1);
    await assert.rejects(f.store.configure(credential, { content: 'fixture-competing' }), /CREDENTIAL_BUSY/);
    failRelease = false; await Promise.all([attempt.retryCleanup(), attempt.retryCleanup()]);
    assert.equal(attempt.result.status, 'configured'); assert.equal(runs, 1); assert.equal(reads, 1); assert.equal(attempt.result.credential!.revision, 1);
  } finally { await f.cleanup(); }
});

test('driver exceptions retain a recovery handle and late cancellation prevents saving', async () => {
  const f = await fixture();
  try {
    const unknown = await f.coordinator.run({ identity, credential }, driver({ run: async () => { throw new Error('fixture-private-execution-error'); },
      recover: async () => proof({ resource: null, phase: 'failed', exitCode: null, stop: 'not_started', cleanup: 'not_created' }) }));
    assert.equal(unknown.result.status, 'pending_cleanup'); assert.ok(!JSON.stringify(unknown).includes('fixture-private-execution-error'));
    await unknown.retryCleanup(); assert.equal(unknown.result.status, 'failed');
    let cancelled = false;
    const late = await f.coordinator.run({ identity, credential }, driver({ readCredential: async () => { cancelled = true; return 'fixture-too-late'; } }), { requested: () => cancelled });
    assert.equal(late.result.status, 'failed'); assert.equal(await f.store.inspect(credential), null);
  } finally { await f.cleanup(); }
});

test('malformed execution evidence cannot save a credential or release management', async () => {
  const f = await fixture();
  try {
    const attempt = await f.coordinator.run({ identity, credential }, driver({ run: async () => proof({ resource: { id: '' } }),
      recover: async () => proof({ resource: null, phase: 'failed', exitCode: null, stop: 'not_started', cleanup: 'not_created' }) }));
    assert.equal(attempt.result.status, 'pending_cleanup'); await assert.rejects(f.store.delete(credential), /CREDENTIAL_BUSY/);
    await attempt.retryCleanup(); assert.equal(attempt.result.status, 'failed'); assert.equal(await f.store.inspect(credential), null);
  } finally { await f.cleanup(); }
});

test('management release retries without querying an already released workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-login-release-'));
  class RetryStore extends FileCredentialStore {
    override async acquireManagement(...args: Parameters<FileCredentialStore['acquireManagement']>) {
      const lease = await super.acquireManagement(...args); let fail = true;
      return { get metadata() { return lease.metadata; }, configure: (content: string) => lease.configure(content), release: async () => {
        if (fail) { fail = false; throw new Error('injected release failure'); } await lease.release();
      } };
    }
  }
  try {
    const store = new RetryStore(root, [codec]); let privateRelease = 0;
    const attempt = await new SubscriptionLoginCoordinator(store).run({ identity, credential }, driver({
      release: async () => { privateRelease++; }, recover: async () => { throw new Error('workspace already deleted'); },
    }));
    assert.equal(attempt.result.status, 'pending_cleanup'); await assert.rejects(store.delete(credential), /CREDENTIAL_BUSY/);
    await attempt.retryCleanup(); assert.equal(attempt.result.status, 'configured'); assert.equal(privateRelease, 1);
    assert.equal(attempt.result.credential!.revision, 1);
    const lease = await store.acquire(credential); await lease.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
