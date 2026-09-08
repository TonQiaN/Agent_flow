import { isIdentifier } from '@agentflow/domain';
import type { CredentialCodec } from './file-store.js';

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const token = (x: unknown): x is string => typeof x === 'string' && x.length >= 4 && x.length <= 64 * 1024 && !/[\s\0]/.test(x);
interface Auth { auth_mode: 'chatgpt'; tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string } }
function parse(content: string): Auth {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new Error('INVALID_CODEX_AUTH');
  const value: unknown = JSON.parse(content);
  if (!record(value) || value['auth_mode'] !== 'chatgpt' || value['OPENAI_API_KEY'] != null
    || Object.keys(value).some(k => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(k))
    || !record(value['tokens']) || Object.keys(value['tokens']).sort().join(',') !== 'access_token,account_id,id_token,refresh_token'
    || !Object.values(value['tokens']).every(token)
    || value['last_refresh'] !== undefined && value['last_refresh'] !== null
      && (typeof value['last_refresh'] !== 'string' || !Number.isFinite(Date.parse(value['last_refresh'])))) throw new Error('INVALID_CODEX_AUTH');
  return value as unknown as Auth;
}

export class CodexSubscriptionCodec implements CredentialCodec {
  readonly service = 'openai'; readonly method = 'subscription';
  validate(content: string): boolean { try { parse(content); return true; } catch { return false; } }
  validateRefresh(previous: string, next: string): boolean {
    try { return parse(previous).tokens.account_id === parse(next).tokens.account_id; } catch { return false; }
  }
}

export interface CodexSubscriptionProfile {
  readonly id: string; readonly service: 'openai'; readonly method: 'subscription'; readonly credentialRef: string;
  readonly endpoint: 'official'; readonly capacity: 1;
}
export const CODEX_SUBSCRIPTION_HOSTS: readonly string[] = Object.freeze(['chatgpt.com', 'auth.openai.com']);
export function codexSubscriptionProfile(value: CodexSubscriptionProfile): CodexSubscriptionProfile {
  if (!value || Object.keys(value).sort().join(',') !== 'capacity,credentialRef,endpoint,id,method,service'
    || !isIdentifier(value.id) || !isIdentifier(value.credentialRef) || value.service !== 'openai' || value.method !== 'subscription'
    || value.endpoint !== 'official' || value.capacity !== 1) throw new Error('UNSUPPORTED_CODEX_PROFILE');
  return Object.freeze({ ...value });
}

/** Known credential values only. This is not a general filter for business PII or arbitrary encodings. */
export class CodexCredentialRedactor {
  readonly #values = new Set<string>();
  remember(content: string): void {
    const auth = parse(content);
    for (const value of Object.values(auth.tokens)) this.#values.add(value);
    // A decoded ID token may also be described by the CLI; retain only known identity strings.
    try {
      const payload: unknown = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (record(payload)) for (const key of ['email', 'sub']) if (token(payload[key])) this.#values.add(payload[key]);
    } catch { /* Opaque/non-JWT IDs still have their complete value protected above. */ }
    if (this.#values.size > 64) throw new Error('REDACTION_VALUE_LIMIT');
  }
  redact(text: string): string {
    if (typeof text !== 'string') throw new Error('INVALID_REDACTION_INPUT');
    let safe = text;
    const values = [...this.#values].flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
      .sort((a, b) => b.length - a.length);
    for (const value of values) safe = safe.split(value).join('[redacted]');
    return safe;
  }
  toJSON(): { configured: boolean } { return { configured: this.#values.size > 0 }; }
}
