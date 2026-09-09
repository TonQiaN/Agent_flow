import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerResult, CredentialStore } from '@agentflow/engine';
import { EnvironmentExecutionCredentialBinding } from './environment-binding.js';
import { FileCredentialStore } from './file-store.js';
import { DeepSeekApiKeyCodec, deepseekApiKeyEnvironment, DeepSeekCredentialRedactor } from './deepseek-api-key.js';
import { credentialEnvironment } from '../execution/state-binding.js';
const identity = { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 };
const credential = { credentialRef: 'key', service: 'deepseek', method: 'api-key' };
const content = (key: string) => JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: key });
const proof = (patch: Partial<RunnerResult> = {}): RunnerResult => ({ identity, resource: { id: 'resource' }, phase: 'exited', exitCode: 0,
  stop: 'confirmed', cleanup: 'removed', capture: null, diagnostics: [], startedAt: 1, finishedAt: 2, ...patch });

test('environment snapshots never create task files or rewrite rotated/deleted source; public views omit secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-env-binding-'));
  try {
    const store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
    await store.configure(credential, { content: content('fixture-original-key') });
    const redactor = new DeepSeekCredentialRedactor();
    const binding = await EnvironmentExecutionCredentialBinding.acquire(store, { identity, credential }, deepseekApiKeyEnvironment, 0, value => redactor.remember(value));
    const other = await EnvironmentExecutionCredentialBinding.acquire(store, { identity, credential }, deepseekApiKeyEnvironment);
    assert.throws(() => binding.secretEnvironment({ id: 'resource' }), /BINDING_EXECUTION_MISMATCH/);
    await binding.prepare({ id: 'resource' }, join(root, 'never-created'));
    assert.deepEqual(await readdir(root), ['store']);
    assert.deepEqual(binding.secretEnvironment({ id: 'resource' }), { DEEPSEEK_API_KEY: 'fixture-original-key' });
    await store.configure(credential, { content: content('fixture-rotated-key') });
    await store.delete(credential);
    assert.equal(binding.secretEnvironment({ id: 'resource' })['DEEPSEEK_API_KEY'], 'fixture-original-key');
    assert.ok(!JSON.stringify({ binding, redactor }).includes('fixture-original-key'));
    assert.equal(redactor.redact('fixture-original-key'), '[redacted]');
    assert.equal((await binding.finish(proof())).refresh, 'unchanged');
    assert.equal(await store.inspect(credential), null);
    assert.throws(() => binding.secretEnvironment({ id: 'resource' }), /BINDING_EXECUTION_MISMATCH/);
    await other.abandon(); await binding.beforeRelease({ id: 'resource' });
    assert.deepEqual(await binding.finish(proof()), await binding.finish(proof()));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown stop and wrong execution retain environment binding; failed/cancelled execution can finalize after confirmed removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-env-proof-'));
  try {
    const store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
    await store.configure(credential, { content: content('fixture-key-proof') });
    const mutable = { identity: { ...identity }, credential: { ...credential } };
    const pending = EnvironmentExecutionCredentialBinding.acquire(store, mutable, deepseekApiKeyEnvironment);
    mutable.identity.runId = 'changed'; mutable.credential.credentialRef = 'changed';
    const binding = await pending;
    await binding.prepare({ id: 'resource' }, root);
    await assert.rejects(binding.prepare({ id: 'other' }, root), /BINDING_ALREADY_USED/);
    await assert.rejects(binding.finish(proof({ identity: mutable.identity })), /BINDING_EXECUTION_MISMATCH/);
    await assert.rejects(binding.finish(proof({ resource: { id: 'other' } })), /BINDING_EXECUTION_MISMATCH/);
    assert.equal((await binding.finish(proof({ stop: 'unknown', cleanup: 'blocked' }))).status, 'retained');
    await assert.rejects(binding.beforeRelease({ id: 'resource' }), /BINDING_NOT_FINALIZED/);
    await assert.rejects(binding.abandon(), /EXECUTION_PROOF_REQUIRED/);
    // Unknown old execution does not hold the static source lease.
    await store.configure(credential, { content: content('fixture-newer-key') });
    assert.equal((await binding.finish(proof({ phase: 'cancelled', exitCode: null }))).status, 'released');
    assert.equal((await store.inspect(credential))!.revision, 2);
    await assert.rejects(binding.beforeRelease({ id: 'other' }), /BINDING_NOT_FINALIZED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source and conversion errors are static, release the source lease, and cannot inject process configuration', async () => {
  let released = 0;
  const fake = (readSecret: () => Promise<string>, release = async () => { released++; }): CredentialStore => ({
    acquire: async () => ({ metadata: { ...credential, generation: 'generation', revision: 1, remoteStatus: 'unknown' }, readSecret, release,
      commitSecret: async () => { throw new Error('MUST_NOT_WRITE'); } }),
  } as unknown as CredentialStore);
  await assert.rejects(EnvironmentExecutionCredentialBinding.acquire(fake(async () => { throw new Error('fixture-secret'); }), { identity, credential }, deepseekApiKeyEnvironment), { message: 'CREDENTIAL_SNAPSHOT_FAILED' });
  assert.equal(released, 1);
  for (const value of [{ NODE_OPTIONS: 'fixture-secret' }, { HTTP_PROXY: 'fixture-secret' }, { AGENTFLOW_API_KEY: 'fixture-secret' }, { DEEPSEEK_API_KEY: 'new\nline' }, {}]) {
    await assert.rejects(EnvironmentExecutionCredentialBinding.acquire(fake(async () => 'fixture-secret'), { identity, credential }, () => value), { message: 'CREDENTIAL_SNAPSHOT_FAILED' });
  }
  assert.equal(released, 6);
  await assert.rejects(EnvironmentExecutionCredentialBinding.acquire(fake(async () => content('fixture-selected'), async () => { throw new Error('fixture-secret'); }), { identity, credential }, deepseekApiKeyEnvironment), { message: 'CREDENTIAL_LEASE_RELEASE_FAILED' });
  assert.throws(() => credentialEnvironment({ DEEPSEEK_API_KEY: 'x'.repeat(8193) }), /INVALID_CREDENTIAL_ENVIRONMENT/);
});

test('immutable environment recovery description omits key versions and management binding cannot execute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-env-resource-'));
  try {
    const store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
    await store.configure(credential, { content: content('fixture-resource-key') });
    const binding = await EnvironmentExecutionCredentialBinding.acquire(store, { identity, credential }, deepseekApiKeyEnvironment);
    const definition = binding.resourceDefinition();
    assert.deepEqual(definition, { schema: 'agentflow-environment-resource/v1', credential, keys: ['DEEPSEEK_API_KEY'] });
    assert.ok(!JSON.stringify(definition).includes('fixture-resource-key')); assert.ok(!JSON.stringify(definition).includes('generation'));
    const restored = EnvironmentExecutionCredentialBinding.recoveryBinding(credential, ['DEEPSEEK_API_KEY']);
    assert.deepEqual(restored.resourceDefinition!(), definition);
    await assert.rejects(restored.beforeRelease({ id: 'resource' }), /BINDING_EXECUTION_MISMATCH/);
    await restored.restoreResource!({ id: 'resource' });
    await assert.rejects(restored.prepare({ id: 'resource' }, root), /RECOVERY_BINDING_CANNOT_EXECUTE/);
    assert.throws(() => restored.secretEnvironment!({ id: 'resource' }), /RECOVERY_BINDING_CANNOT_EXECUTE/);
    await assert.rejects(restored.restoreResource!({ id: 'resource' }), /BINDING_ALREADY_USED/);
    await assert.rejects(restored.beforeRelease({ id: 'other' }), /BINDING_EXECUTION_MISMATCH/);
    await restored.beforeRelease({ id: 'resource' });
    await assert.rejects(binding.restoreResource({ id: 'resource' }), /RECOVERY_BINDING_REQUIRED/);
    await binding.abandon();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('environment recovery definitions snapshot trusted identity and reject process configuration keys', () => {
  const mutable = { ...credential }, keys = ['DEEPSEEK_API_KEY'];
  const binding = EnvironmentExecutionCredentialBinding.recoveryBinding(mutable, keys);
  mutable.credentialRef = 'other'; keys[0] = 'OTHER_TOKEN';
  const description: any = binding.resourceDefinition!(); description.credential.credentialRef = 'changed-return';
  assert.deepEqual(binding.resourceDefinition!(), { schema: 'agentflow-environment-resource/v1', credential, keys: ['DEEPSEEK_API_KEY'] });
  for (const bad of [[], ['NODE_OPTIONS'], ['AGENTFLOW_API_KEY'], ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY']])
    assert.throws(() => EnvironmentExecutionCredentialBinding.recoveryBinding(credential, bad), /INVALID_ENVIRONMENT_RESOURCE_DEFINITION/);
});
