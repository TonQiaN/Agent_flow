import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunnerResult, CredentialStore } from '@agentflow/engine';
import { DeepSeekApiKeyCodec, DeepSeekCredentialRedactor, deepseekApiKeyProfile, DEEPSEEK_API_KEY_HOSTS } from './deepseek-api-key.js';
import { FileCredentialStore } from './file-store.js';
import { FileExecutionCredentialBinding } from './execution-binding.js';
const material = (api_key = 'fixture-original-key') => JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key });
const credential = { credentialRef: 'deepseek', service: 'deepseek', method: 'api-key' };
const identity = { runId: 'key-run', nodeTaskId: 'key-node', attemptId: 'key-attempt', attemptNumber: 1 };
const proof = (patch: Partial<RunnerResult> = {}): RunnerResult => ({ identity, resource: { id: 'resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', capture: null, diagnostics: [], startedAt: 1, finishedAt: 2, ...patch });
const options = { identity, credential, stateFile: 'deepseek-api-key.json', environment: {} };
test('DeepSeek key codec matches the fixed launcher record and never trims or echoes malformed secrets', () => {
  const codec = new DeepSeekApiKeyCodec();
  for (const value of ['abcdefgh', 'x'.repeat(8192), 'fixture-quote"slash\\percent%key']) assert.equal(codec.validate(material(value)), true);
  for (const value of ['', 'short', 'x'.repeat(8193), ' whitespace', 'trailing ', 'line\nbreak', 'tab\tvalue', 'null\0value', 'nonASCII密钥', 'delete\x7fkey']) assert.equal(codec.validate(material(value)), false);
  for (const value of ['malformed secret fixture-original-key', '{}', '[]', 'null', JSON.stringify({ api_key: 'fixture-original-key' }),
    JSON.stringify({ schema: 'agentflow-deepseek-key/v2', api_key: 'fixture-original-key' }), JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-original-key', other: true }), ' '.repeat(16385)]) assert.equal(codec.validate(value), false);
  assert.equal(codec.validateRefresh(material(), material('replacement-key')), false); assert.equal(codec.validateRefresh(material(), material()), true);
});
test('DeepSeek profile declares official destination and no authentication-imposed session lock', () => {
  const raw = { id: 'p', ...credential, endpoint: 'official' as const, capacity: null }; const profile = deepseekApiKeyProfile(raw as never);
  raw.credentialRef = 'changed'; assert.equal(profile.credentialRef, 'deepseek'); assert.ok(Object.isFrozen(profile));
  assert.deepEqual(DEEPSEEK_API_KEY_HOSTS, ['api.deepseek.com']); assert.ok(Object.isFrozen(DEEPSEEK_API_KEY_HOSTS));
  for (const patch of [{ capacity: 1 }, { capacity: 'unlimited' }, { endpoint: 'https://elsewhere.test' }, { service: 'openai' }, { method: 'subscription' }, { credentialRef: '../x' }, { key: 'secret' }, { env: {} }])
    assert.throws(() => deepseekApiKeyProfile({ ...raw, ...patch } as never), /UNSUPPORTED_DEEPSEEK_PROFILE/);
});
test('DeepSeek redactor requires an initialized immutable snapshot and hides raw, URL and JSON encodings', () => {
  const r = new DeepSeekCredentialRedactor(), secret = 'fixture-quote"slash\\percent%key';
  assert.throws(() => r.redact('ordinary'), /NOT_READY/); assert.throws(() => r.remember('malformed private-value'), e => e instanceof Error && e.message === 'INVALID_DEEPSEEK_API_KEY');
  r.remember(material(secret)); r.remember(material(secret));
  assert.equal(r.redact([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].join(' ')), '[redacted] [redacted] [redacted]');
  assert.throws(() => r.remember(material('replacement-key')), /SNAPSHOT_CHANGED/); assert.equal(JSON.stringify(r), '{"configured":true}');
  assert.equal(r.redact(secret), '[redacted]');
});
test('DeepSeek storage rejects execution key rotation but permits explicit administrative replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-key-store-')), store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
  try {
    const configured = await store.configure(credential, { content: material() }); assert.equal(configured.remoteStatus, 'unknown');
    const lease = await store.acquire(credential); await assert.rejects(lease.commitSecret(material('replacement-key'), 1), /CREDENTIAL_REFRESH_REJECTED/); await lease.release();
    assert.equal((await store.configure(credential, { content: material('replacement-key') })).revision, 2);
    const next = await store.acquire(credential); assert.equal(await next.readSecret(), material('replacement-key')); await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'af-key-snapshot-')), state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
  const store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]); await store.configure(credential, { content: material() });
  const redactor = new DeepSeekCredentialRedactor(), binding = await FileExecutionCredentialBinding.acquireSnapshot(store, options, 0, content => redactor.remember(content));
  return { root, state, store, binding, copy: join(state, options.stateFile), redactor };
}
test('snapshot bindings allow concurrent aliases and cannot overwrite rotation or resurrect deleted source credentials', async () => {
  const f = await fixture();
  try {
    const second = await FileExecutionCredentialBinding.acquireSnapshot(f.store, { ...options, identity: { ...identity, attemptId: 'second' } });
    const state2 = join(f.root, 'state2'); await mkdir(state2, { mode: 0o700 }); await second.prepare({ id: 'second-resource' }, state2);
    await f.store.configure(credential, { content: material('rotated-source-key') });
    await f.binding.prepare({ id: 'resource' }, f.state);
    assert.equal(await readFile(f.copy, 'utf8'), material()); assert.equal((await stat(f.copy)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(f.binding).includes('fixture-original-key')); assert.ok(!JSON.stringify(f.binding).includes(f.root));
    assert.equal((await f.binding.finish(proof())).refresh, 'unchanged'); assert.equal((await f.store.inspect(credential))!.revision, 2);
    const current = await f.store.acquire(credential); assert.equal(await current.readSecret(), material('rotated-source-key')); await current.release();
    assert.deepEqual(await f.store.delete(credential), { deleted: true, remoteRevoked: false });
    assert.equal((await second.finish(proof({ identity: { ...identity, attemptId: 'second' }, resource: { id: 'second-resource' } }))).refresh, 'unchanged');
    assert.equal(await f.store.inspect(credential), null); await assert.rejects(readFile(f.copy), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('snapshot binding retains copy on unknown stop, validates identity and releases only after cleanup proof', async () => {
  const f = await fixture();
  try {
    await f.binding.prepare({ id: 'resource' }, f.state);
    assert.equal((await f.binding.finish(proof({ stop: 'unknown', cleanup: 'blocked' }))).status, 'retained');
    await assert.rejects(f.binding.beforeRelease({ id: 'resource' }), /BINDING_NOT_FINALIZED/);
    const available = await f.store.acquire(credential); await available.release(); // No running source lease, despite retained task copy.
    await assert.rejects(f.binding.finish(proof({ identity: { ...identity, attemptId: 'other' } })), /BINDING_EXECUTION_MISMATCH/);
    await assert.rejects(f.binding.finish(proof({ resource: { id: 'other' } })), /BINDING_EXECUTION_MISMATCH/);
    assert.equal((await f.binding.finish(proof({ phase: 'cancelled', exitCode: null }))).status, 'released');
    await f.binding.beforeRelease({ id: 'resource' }); await assert.rejects(readFile(f.copy), { code: 'ENOENT' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('changed, missing or linked key copies fail closeout without changing the source snapshot', async () => {
  for (const mode of ['changed', 'missing', 'linked']) {
    const f = await fixture();
    try {
      await f.binding.prepare({ id: 'resource' }, f.state);
      const outside = join(f.root, 'outside'); await writeFile(outside, material('outside-key'), { mode: 0o600 });
      if (mode === 'changed') await writeFile(f.copy, material('substituted-key')); else { await rm(f.copy); if (mode === 'linked') await symlink(outside, f.copy); }
      const result = await f.binding.finish(proof()); assert.equal(result.status, 'released'); assert.equal(result.refresh, 'failed');
      assert.deepEqual(result.diagnostics, ['CREDENTIAL_REFRESH_FAILED']); assert.equal((await f.store.inspect(credential))!.revision, 1);
      assert.equal(await readFile(outside, 'utf8'), material('outside-key')); await assert.rejects(readFile(f.copy), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('snapshot acquisition releases failed reads and never exposes secret-bearing store errors', async () => {
  for (const releaseFails of [false, true]) {
    let releases = 0;
    const store = { async acquire() { return { metadata: { ...credential, generation: 'fixture', revision: 1, remoteStatus: 'unknown' },
      async readSecret() { throw new Error('fixture-private-store-error'); }, async release() { releases++; if (releaseFails) throw new Error('fixture-private-release-error'); } }; } } as unknown as CredentialStore;
    await assert.rejects(FileExecutionCredentialBinding.acquireSnapshot(store, options), e => e instanceof Error && e.message === (releaseFails ? 'CREDENTIAL_LEASE_RELEASE_FAILED' : 'CREDENTIAL_SNAPSHOT_FAILED'));
    assert.equal(releases, 1);
  }
});
