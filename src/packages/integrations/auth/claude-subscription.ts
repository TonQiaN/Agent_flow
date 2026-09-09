import { isIdentifier } from '@agentflow/domain';
import type { CredentialCodec } from './file-store.js';

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const token = (x: unknown): x is string => typeof x === 'string' && x.length >= 4 && x.length <= 65536 && !/[\s\0]/.test(x);
const label = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(x);
interface OAuth { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[]; clientId?: string }
function parse(content: string): OAuth {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new Error('INVALID_CLAUDE_AUTH');
  const value: unknown = JSON.parse(content);
  if (!object(value) || Object.keys(value).join(',') !== 'claudeAiOauth' || !object(value['claudeAiOauth'])) throw new Error('INVALID_CLAUDE_AUTH');
  const a = value['claudeAiOauth'];
  const cleared = a['accessToken'] === '' && a['refreshToken'] === '' && a['expiresAt'] === 0;
  if (Object.keys(a).some(k => !['accessToken', 'refreshToken', 'expiresAt', 'refreshTokenExpiresAt', 'scopes', 'subscriptionType', 'rateLimitTier', 'clientId'].includes(k))
    || !cleared && (!token(a['accessToken']) || !token(a['refreshToken']) || !Number.isSafeInteger(a['expiresAt']) || (a['expiresAt'] as number) <= 0)
    || !Array.isArray(a['scopes']) || a['scopes'].length > 32 || !a['scopes'].every(label) || !a['scopes'].includes('user:inference')
    || new Set(a['scopes']).size !== a['scopes'].length
    || a['refreshTokenExpiresAt'] != null && (!Number.isSafeInteger(a['refreshTokenExpiresAt']) || (a['refreshTokenExpiresAt'] as number) <= 0)
    || ['subscriptionType', 'rateLimitTier', 'clientId'].some(k => a[k] != null && !label(a[k]))) throw new Error('INVALID_CLAUDE_AUTH');
  return a as unknown as OAuth;
}

/** Includes the CLI's explicit invalid-grant tombstone; neither form proves remote validity. */
export class ClaudeSubscriptionCodec implements CredentialCodec {
  readonly service = 'anthropic'; readonly method = 'subscription';
  validate(content: string): boolean { try { parse(content); return true; } catch { return false; } }
  /** A refresh tombstone may be stored, but cannot establish a new login. */
  validateLogin(content: string): boolean { try { return parse(content).accessToken !== ''; } catch { return false; } }
  validateRefresh(previous: string, next: string): boolean {
    try { const a = parse(previous), b = parse(next); return (a.clientId ?? null) === (b.clientId ?? null) && (a.accessToken !== '' || b.accessToken === ''); }
    catch { return false; }
  }
}

export interface ClaudeSubscriptionProfile {
  readonly id: string; readonly service: 'anthropic'; readonly method: 'subscription'; readonly credentialRef: string;
  readonly endpoint: 'official'; readonly capacity: 1;
}
export const CLAUDE_SUBSCRIPTION_HOSTS: readonly string[] = Object.freeze(['api.anthropic.com', 'platform.claude.com']);
export function claudeSubscriptionProfile(value: ClaudeSubscriptionProfile): ClaudeSubscriptionProfile {
  if (!value || Object.keys(value).sort().join(',') !== 'capacity,credentialRef,endpoint,id,method,service'
    || !isIdentifier(value.id) || !isIdentifier(value.credentialRef) || value.service !== 'anthropic' || value.method !== 'subscription'
    || value.endpoint !== 'official' || value.capacity !== 1) throw new Error('UNSUPPORTED_CLAUDE_PROFILE');
  return Object.freeze({ ...value });
}

/** Remembers initial and refreshed secrets, rejecting a cleared credential only before execution. */
export class ClaudeCredentialRedactor {
  readonly #values = new Set<string>();
  #observed = false;
  remember(content: string): void {
    const a = parse(content);
    if (!this.#observed && a.accessToken === '') throw new Error('CLAUDE_CREDENTIAL_RECONFIGURATION_REQUIRED');
    this.#observed = true;
    for (const value of [a.accessToken, a.refreshToken]) if (value) this.#values.add(value);
    if (this.#values.size > 64) throw new Error('REDACTION_VALUE_LIMIT');
  }
  redact(text: string): string {
    if (typeof text !== 'string') throw new Error('INVALID_REDACTION_INPUT');
    let safe = text;
    for (const value of [...this.#values].flatMap(v => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]).sort((a, b) => b.length - a.length)) safe = safe.split(value).join('[redacted]');
    return safe;
  }
  toJSON(): { configured: boolean } { return { configured: this.#observed }; }
}
