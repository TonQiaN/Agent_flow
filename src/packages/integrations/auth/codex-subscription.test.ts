import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCredentialRedactor, CodexSubscriptionCodec, codexSubscriptionProfile } from './codex-subscription.js';
import { FileCredentialStore } from './file-store.js';

const auth = (account = 'fixture-account', suffix = 'original') => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: `fixture-id-${suffix}`, access_token: `fixture-access-${suffix}`, refresh_token: `fixture-refresh-${suffix}`, account_id: account }, last_refresh: '2026-09-09T00:00:00Z' });
test('Codex codec accepts managed subscription bundles and rejects other modes or incomplete fields', () => {
  const codec = new CodexSubscriptionCodec(); assert.equal(codec.validate(auth()), true);
  const base = JSON.parse(auth());
  for (const value of [{ ...base, auth_mode: 'chatgptAuthTokens' }, { ...base, OPENAI_API_KEY: 'fixture-key' },
    { ...base, tokens: { refresh_token: 'fixture-refresh' } }, { ...base, last_refresh: 'invalid' }, { ...base, extra: true }]) assert.equal(codec.validate(JSON.stringify(value)), false);
  assert.equal(codec.validate('invalid'), false);
});
test('lease refresh cannot switch Codex account; explicit administrative replacement remains possible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-codex-codec-'));
  const identity = { credentialRef: 'codex', service: 'openai', method: 'subscription' };
  const store = new FileCredentialStore(join(root, 'store'), [new CodexSubscriptionCodec()]);
  try {
    await store.configure(identity, { content: auth() }); const lease = await store.acquire(identity);
    await assert.rejects(lease.commitSecret(auth('other-account', 'new'), 1), /CREDENTIAL_REFRESH_REJECTED/);
    assert.equal(lease.metadata.revision, 1); assert.equal(await lease.readSecret(), auth());
    assert.equal((await lease.commitSecret(auth('fixture-account', 'new'), 1)).revision, 2); await lease.release();
    assert.equal((await store.configure(identity, { content: auth('other-account') })).revision, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Codex Profile is explicit, immutable and limited to official subscription capacity one', () => {
  const profile = { id: 'sample', service: 'openai' as const, method: 'subscription' as const, credentialRef: 'codex', endpoint: 'official' as const, capacity: 1 as const };
  const saved = codexSubscriptionProfile(profile); profile.credentialRef = 'changed'; assert.equal(saved.credentialRef, 'codex');
  for (const patch of [{ endpoint: 'https://elsewhere.test' }, { capacity: 2 }, { method: 'api-key' }, { extra: true }]) {
    assert.throws(() => codexSubscriptionProfile({ ...profile, ...patch } as never), /UNSUPPORTED_CODEX_PROFILE/);
  }
});
test('redactor remembers original and refreshed tokens plus known ID claims without serializing them', () => {
  const redactor = new CodexCredentialRedactor(); redactor.remember(auth()); redactor.remember(auth('fixture-account', 'new'));
  const payload = Buffer.from(JSON.stringify({ email: 'fixture@example.test', sub: 'fixture-subject' })).toString('base64url');
  const jwt = JSON.parse(auth()); jwt.tokens.id_token = `header.${payload}.signature`; redactor.remember(JSON.stringify(jwt));
  const raw = `fixture-access-original fixture-refresh-new fixture-account fixture@example.test fixture-subject header.${payload}.signature`;
  assert.ok(!redactor.redact(raw).includes('fixture')); assert.ok(!JSON.stringify(redactor).includes('fixture'));
  assert.equal(redactor.redact('ordinary task text'), 'ordinary task text'); assert.throws(() => redactor.remember('malformed'));
});
