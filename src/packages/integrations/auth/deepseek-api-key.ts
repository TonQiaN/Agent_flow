import { isIdentifier } from '@agentflow/domain';
import { snapshotJson } from '@agentflow/engine';
import type { CredentialCodec } from './file-store.js';

function key(content: string): string {
  try {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 16384) throw new Error();
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'api_key,schema'
      || !('schema' in value) || value.schema !== 'agentflow-deepseek-key/v1' || !('api_key' in value)
      || typeof value.api_key !== 'string' || value.api_key.length < 8 || value.api_key.length > 8192 || /[^\x21-\x7e]/.test(value.api_key)) throw new Error();
    return value.api_key;
  } catch { throw new Error('INVALID_DEEPSEEK_API_KEY'); }
}

/** Static key format only; validation does not contact the provider. Rotation is administrative configure. */
export class DeepSeekApiKeyCodec implements CredentialCodec {
  readonly service = 'deepseek'; readonly method = 'api-key';
  validate(content: string): boolean { try { key(content); return true; } catch { return false; } }
  validateRefresh(previous: string, next: string): boolean { try { return key(previous) === key(next); } catch { return false; } }
}
export interface DeepSeekApiKeyProfile {
  readonly id: string; readonly service: 'deepseek'; readonly method: 'api-key'; readonly credentialRef: string;
  readonly endpoint: 'official';
  /** No authentication-imposed session lock. This says nothing about remote limits or scheduling concurrency. */
  readonly capacity: null;
}
export const DEEPSEEK_API_KEY_HOSTS: readonly string[] = Object.freeze(['api.deepseek.com']);
export function deepseekApiKeyProfile(raw: DeepSeekApiKeyProfile): DeepSeekApiKeyProfile {
  let value: DeepSeekApiKeyProfile;
  try { value = snapshotJson(raw) as unknown as DeepSeekApiKeyProfile; } catch { throw new Error('UNSUPPORTED_DEEPSEEK_PROFILE'); }
  if (!value || Object.keys(value).sort().join(',') !== 'capacity,credentialRef,endpoint,id,method,service' || !isIdentifier(value.id) || !isIdentifier(value.credentialRef)
    || value.service !== 'deepseek' || value.method !== 'api-key' || value.endpoint !== 'official' || value.capacity !== null) throw new Error('UNSUPPORTED_DEEPSEEK_PROFILE');
  return Object.freeze(value);
}

/** One immutable execution snapshot, never ambient credentials. Known-value redaction is not arbitrary PII filtering. */
export class DeepSeekCredentialRedactor {
  #value: string | null = null;
  remember(content: string): void {
    const next = key(content);
    if (this.#value !== null && this.#value !== next) throw new Error('DEEPSEEK_KEY_SNAPSHOT_CHANGED');
    this.#value = next;
  }
  redact(text: string): string {
    if (typeof text !== 'string' || this.#value === null) throw new Error('DEEPSEEK_REDACTION_NOT_READY');
    let safe = text;
    for (const value of [...new Set([this.#value, encodeURIComponent(this.#value), JSON.stringify(this.#value).slice(1, -1)])].sort((a, b) => b.length - a.length))
      safe = safe.split(value).join('[redacted]');
    return safe;
  }
  toJSON(): { configured: boolean } { return { configured: this.#value !== null }; }
}

/** Trusted authentication binding only; the Adapter declares the variable but never reads the value. */
export function deepseekApiKeyEnvironment(content: string): Readonly<Record<string, string>> {
  return Object.freeze({ DEEPSEEK_API_KEY: key(content) });
}
