import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCredentialRedactor, ClaudeSubscriptionCodec, claudeSubscriptionProfile } from './claude-subscription.js';
import { FileCredentialStore } from './file-store.js';

const auth = (suffix = 'original') => ({ claudeAiOauth: { accessToken: `fixture-access-${suffix}`, refreshToken: `fixture-refresh-${suffix}`,
  expiresAt: 1800000000000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } });
const cleared = () => ({ claudeAiOauth: { ...auth().claudeAiOauth, accessToken: '', refreshToken: '', expiresAt: 0 } });
test('Claude codec validates fixed Linux file format and distinguishes malformed state from explicit invalid-grant clearing', () => {
  const codec = new ClaudeSubscriptionCodec();
  for (const a of [auth(), cleared(), { claudeAiOauth: { ...auth().claudeAiOauth, refreshTokenExpiresAt: 1900000000000, clientId: 'fixture-client' } }]) assert.equal(codec.validate(JSON.stringify(a)), true);
  for (const a of [null, [], {}, { ...auth(), mcpOAuth: { secret: 'other-service' } }, { ...auth(), apiKey: 'fixture-key' },
    ...[{ accessToken: '' }, { expiresAt: -1 }, { expiresAt: '123' }, { refreshTokenExpiresAt: -1 }, { refreshToken: 'white space' },
      { scopes: [] }, { scopes: ['user:inference', 'user:inference'] }, { scopes: ['user:inference', null] }, { clientId: {} }, { unexpected: true }].map(patch => ({ claudeAiOauth: { ...auth().claudeAiOauth, ...patch } }))]) assert.equal(codec.validate(JSON.stringify(a)), false);
  assert.equal(codec.validate('invalid'), false); assert.equal(codec.validate(' '.repeat(1024 * 1024 + 1)), false);
});
test('Claude lease preserves invalid-grant state and forbids implicit resurrection or client replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-claude-codec-')); const identity = { credentialRef: 'claude', service: 'anthropic', method: 'subscription' };
  const store = new FileCredentialStore(join(root, 'store'), [new ClaudeSubscriptionCodec()]);
  try {
    await store.configure(identity, { content: JSON.stringify(auth()) }); const lease = await store.acquire(identity);
    await assert.rejects(lease.commitSecret(JSON.stringify({ claudeAiOauth: { ...auth().claudeAiOauth, clientId: 'other-client' } }), 1), /CREDENTIAL_REFRESH_REJECTED/);
    assert.equal((await lease.commitSecret(JSON.stringify(auth('new')), 1)).revision, 2);
    assert.equal((await lease.commitSecret(JSON.stringify(cleared()), 2)).revision, 3);
    await assert.rejects(lease.commitSecret(JSON.stringify(auth()), 3), /CREDENTIAL_REFRESH_REJECTED/);
    assert.equal(await lease.readSecret(), JSON.stringify(cleared())); await lease.release();
    assert.equal((await store.configure(identity, { content: JSON.stringify(auth()) })).revision, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Claude Profile keeps explicit official endpoint and exclusive capacity', () => {
  const p = { id: 'sample', service: 'anthropic' as const, method: 'subscription' as const, credentialRef: 'claude', endpoint: 'official' as const, capacity: 1 as const };
  const saved = claudeSubscriptionProfile(p); p.credentialRef = 'changed'; assert.equal(saved.credentialRef, 'claude'); assert.ok(Object.isFrozen(saved));
  for (const patch of [{ endpoint: 'https://elsewhere.test' }, { capacity: 2 }, { method: 'api-key' }, { service: 'openai' }, { extra: true }]) assert.throws(() => claudeSubscriptionProfile({ ...p, ...patch } as never), /UNSUPPORTED_CLAUDE_PROFILE/);
});
test('Claude redactor covers original and refreshed tokens, accepts clearing only after initialization and leaks no state', () => {
  const r = new ClaudeCredentialRedactor(); assert.throws(() => r.remember(JSON.stringify(cleared())), /RECONFIGURATION_REQUIRED/);
  r.remember(JSON.stringify(auth())); r.remember(JSON.stringify(auth('new'))); r.remember(JSON.stringify(cleared()));
  assert.equal(r.redact('fixture-access-original fixture-refresh-new ordinary'), '[redacted] [redacted] ordinary');
  assert.equal(JSON.stringify(r), '{"configured":true}'); assert.throws(() => r.remember('malformed'));
});
