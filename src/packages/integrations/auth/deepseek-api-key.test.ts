import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekApiKeyCodec, DeepSeekCredentialRedactor, deepseekApiKeyProfile, DEEPSEEK_API_KEY_HOSTS } from './deepseek-api-key.js';
import { FileCredentialStore } from './file-store.js';
const material = (api_key = 'fixture-original-key') => JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key });
const credential = { credentialRef: 'deepseek', service: 'deepseek', method: 'api-key' };
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
