import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity } from '@agentflow/domain';
import type { CredentialIdentity, CredentialMetadata, CredentialStore, ExecutionResource, RunnerResult } from '@agentflow/engine';
import { CredentialError } from './file-store.js';
import type { BindingFinalization, ExecutionCredentialBinding } from './execution-binding.js';
import { credentialEnvironment } from '../execution/state-binding.js';

/** Immutable credential snapshot, delivered only to the trusted process environment channel. No task secret file. */
export class EnvironmentExecutionCredentialBinding implements ExecutionCredentialBinding {
  readonly environment = Object.freeze({});
  readonly #identity: ExecutionIdentity;
  readonly #metadata: CredentialMetadata;
  #secrets: Readonly<Record<string, string>> | null;
  #resource: string | null = null;
  #released = false;
  #result: BindingFinalization | null = null;
  private constructor(identity: ExecutionIdentity, metadata: CredentialMetadata, secrets: Readonly<Record<string, string>>) {
    this.#identity = Object.freeze({ ...identity }); this.#metadata = Object.freeze({ ...metadata }); this.#secrets = secrets;
  }
  static async acquire(store: CredentialStore, options: { readonly identity: ExecutionIdentity; readonly credential: CredentialIdentity },
    convert: (content: string) => Readonly<Record<string, string>>, waitMs = 0, remember?: (content: string) => void): Promise<EnvironmentExecutionCredentialBinding> {
    if (!options || Object.keys(options).sort().join(',') !== 'credential,identity' || !isExecutionIdentity(options.identity)
      || typeof convert !== 'function' || remember !== undefined && typeof remember !== 'function') throw new CredentialError('INVALID_CREDENTIAL_BINDING');
    const identity = Object.freeze({ ...options.identity }), credential = Object.freeze({ ...options.credential });
    const lease = await store.acquire(credential, waitMs);
    try {
      const content = await lease.readSecret();
      const secrets = credentialEnvironment(convert(content));
      if (!Object.keys(secrets).length) throw new Error();
      remember?.(content);
      return new EnvironmentExecutionCredentialBinding(identity, lease.metadata, secrets);
    } catch { throw new CredentialError('CREDENTIAL_SNAPSHOT_FAILED'); }
    finally { try { await lease.release(); } catch { throw new CredentialError('CREDENTIAL_LEASE_RELEASE_FAILED'); } }
  }
  get metadata(): CredentialMetadata { return this.#metadata; }
  toJSON(): { credential: CredentialMetadata; released: boolean } { return { credential: this.metadata, released: this.#released }; }
  async prepare(resource: ExecutionResource, _stateDirectory: string): Promise<void> {
    if (this.#released || this.#resource !== null) throw new CredentialError('BINDING_ALREADY_USED');
    if (!resource || typeof resource.id !== 'string' || !resource.id) throw new CredentialError('INVALID_BINDING_RESOURCE');
    this.#resource = resource.id;
  }
  secretEnvironment(resource: ExecutionResource): Readonly<Record<string, string>> {
    if (!this.#secrets || this.#released || !resource || resource.id !== this.#resource) throw new CredentialError('BINDING_EXECUTION_MISMATCH');
    return Object.freeze({ ...this.#secrets });
  }
  async abandon(): Promise<void> {
    if (this.#released) return;
    if (this.#resource !== null) throw new CredentialError('EXECUTION_PROOF_REQUIRED');
    this.#secrets = null; this.#released = true;
  }
  async beforeRelease(resource: ExecutionResource): Promise<void> {
    if (!this.#released || this.#resource !== null && resource.id !== this.#resource) throw new CredentialError('BINDING_NOT_FINALIZED');
  }
  async finish(result: RunnerResult): Promise<BindingFinalization> {
    if (!result || !isExecutionIdentity(result.identity) || Object.entries(this.#identity).some(([key, value]) => result.identity[key as keyof ExecutionIdentity] !== value)
      || this.#resource !== null && result.resource?.id !== this.#resource) throw new CredentialError('BINDING_EXECUTION_MISMATCH');
    if (this.#result) return this.#result;
    if (this.#released) throw new CredentialError('BINDING_ALREADY_RELEASED');
    if (result.resource ? result.stop !== 'confirmed' || result.cleanup !== 'removed' : result.stop !== 'not_started' || result.cleanup !== 'not_created')
      return Object.freeze({ status: 'retained', refresh: 'pending', credential: this.metadata, diagnostics: Object.freeze(['EXECUTION_NOT_CLEANED']) });
    this.#secrets = null; this.#released = true;
    this.#result = Object.freeze({ status: 'released', refresh: this.#resource === null ? 'not_prepared' : 'unchanged', credential: this.metadata, diagnostics: Object.freeze([]) });
    return this.#result;
  }
}
