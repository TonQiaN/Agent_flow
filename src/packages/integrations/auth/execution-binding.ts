import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity } from '@agentflow/domain';
import type { CredentialIdentity, CredentialLease, CredentialMetadata, CredentialStore, ExecutionResource, RunnerResult } from '@agentflow/engine';
import { CredentialError, readPrivate } from './file-store.js';
import { stateEnvironment } from '../execution/state-binding.js';
import type { PrivateStateBinding } from '../execution/state-binding.js';

export interface CredentialBindingOptions {
  readonly identity: ExecutionIdentity;
  readonly credential: CredentialIdentity;
  /** Host-selected relative location in the private state directory. Never a source store path. */
  readonly stateFile: string;
  readonly environment: Readonly<Record<string, string>>;
}
export interface BindingFinalization {
  readonly status: 'released' | 'retained';
  readonly refresh: 'not_prepared' | 'unchanged' | 'updated' | 'failed' | 'pending';
  readonly credential: CredentialMetadata;
  readonly diagnostics: readonly string[];
}

/** Shared lifecycle consumed by execution composition, independent of secret transport. */
export interface ExecutionCredentialBinding extends PrivateStateBinding {
  abandon(): Promise<void>;
  finish(result: RunnerResult): Promise<BindingFinalization>;
}

/** An exclusive lease with one execution copy. No Harness or business-outcome interpretation. */
export class FileExecutionCredentialBinding implements ExecutionCredentialBinding {
  readonly environment: Readonly<Record<string, string>>;
  readonly #identity: ExecutionIdentity;
  readonly #stateFile: string;
  readonly #lease: CredentialLease;
  readonly #revision: number;
  readonly #remember: ((content: string) => void) | undefined;
  #resource: string | null = null;
  #root: string | null = null;
  #copied = false;
  #ownsFile = false;
  #released = false;
  #result: BindingFinalization | null = null;
  #refresh: BindingFinalization['refresh'] = 'pending';
  #diagnostics: string[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: CredentialBindingOptions, lease: CredentialLease, remember?: (content: string) => void) {
    this.#identity = Object.freeze({ ...options.identity }); this.#stateFile = options.stateFile;
    this.environment = options.environment; this.#lease = lease; this.#revision = lease.metadata.revision;
    this.#remember = remember;
  }
  static async acquire(store: CredentialStore, options: CredentialBindingOptions, waitMs = 0, remember?: (content: string) => void): Promise<FileExecutionCredentialBinding> {
    if (!options || Object.keys(options).sort().join(',') !== 'credential,environment,identity,stateFile'
      || !isExecutionIdentity(options.identity) || typeof options.stateFile !== 'string' || options.stateFile.length > 256
      || options.stateFile.split('/').length > 8 || !options.stateFile.split('/').every(part => /^\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) throw new CredentialError('INVALID_CREDENTIAL_BINDING');
    const snapshot = { ...options, identity: Object.freeze({ ...options.identity }), credential: Object.freeze({ ...options.credential }), environment: stateEnvironment(options.environment) };
    if (remember !== undefined && typeof remember !== 'function') throw new CredentialError('INVALID_SECRET_OBSERVER');
    const lease = await store.acquire(snapshot.credential, waitMs);
    return new FileExecutionCredentialBinding(snapshot, lease, remember);
  }
  get metadata(): CredentialMetadata { return this.#lease.metadata; }
  toJSON(): { credential: CredentialMetadata; released: boolean } { return { credential: this.metadata, released: this.#released }; }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => undefined); return next;
  }

  async #parents(create: boolean): Promise<string> {
    let cursor = this.#root!;
    await directory(cursor);
    const parts = this.#stateFile.split('/');
    for (const part of parts.slice(0, -1)) {
      cursor = join(cursor, part);
      if (create) await mkdir(cursor, { mode: 0o700 }); // Newly allocated subtree; pre-existing paths fail.
      await directory(cursor);
    }
    return join(cursor, parts.at(-1)!);
  }

  prepare(resource: ExecutionResource, stateDirectory: string): Promise<void> {
    return this.#serial(async () => {
      if (this.#released || this.#resource !== null) throw new CredentialError('BINDING_ALREADY_USED');
      if (!resource || typeof resource.id !== 'string' || !resource.id || !isAbsolute(stateDirectory) || stateDirectory.includes('\0')) throw new CredentialError('INVALID_BINDING_RESOURCE');
      this.#resource = resource.id; this.#root = stateDirectory;
      try {
        const target = await this.#parents(true);
        const content = await this.#lease.readSecret();
        this.#remember?.(content);
        const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        this.#ownsFile = true;
        try { await file.writeFile(content, 'utf8'); await file.sync(); this.#copied = true; }
        finally { await file.close(); }
      } catch { throw new CredentialError('CREDENTIAL_PREPARATION_FAILED'); }
    });
  }

  /** For errors before Runner preparation, including request validation. Cannot abandon an execution copy. */
  abandon(): Promise<void> {
    return this.#serial(async () => {
      if (this.#released) return;
      if (this.#resource !== null) throw new CredentialError('EXECUTION_PROOF_REQUIRED');
      await this.#lease.release(); this.#released = true;
    });
  }

  beforeRelease(resource: ExecutionResource): Promise<void> {
    return this.#serial(async () => {
      if (!this.#released || this.#resource !== null && this.#resource !== resource.id) throw new CredentialError('BINDING_NOT_FINALIZED');
    });
  }

  finish(result: RunnerResult): Promise<BindingFinalization> {
    // Snapshot the stop facts before queued IO. This is a trusted host result, never workflow input.
    const proof = { identity: { ...result.identity }, resource: result.resource?.id ?? null, stop: result.stop, cleanup: result.cleanup };
    return this.#serial(async () => {
      if (Object.entries(this.#identity).some(([key, value]) => proof.identity[key as keyof ExecutionIdentity] !== value)
        || this.#resource !== null && proof.resource !== this.#resource) throw new CredentialError('BINDING_EXECUTION_MISMATCH');
      if (this.#result) return this.#result;
      if (this.#released) throw new CredentialError('BINDING_ALREADY_RELEASED');
      const retained = (code: string): BindingFinalization => ({ status: 'retained', refresh: this.#refresh, credential: this.metadata, diagnostics: [...this.#diagnostics, code] });
      if (proof.resource !== null && (proof.stop !== 'confirmed' || proof.cleanup !== 'removed')
        || proof.resource === null && (proof.stop !== 'not_started' || proof.cleanup !== 'not_created')) return retained('EXECUTION_NOT_CLEANED');
      if (this.#ownsFile) {
        let target: string;
        try { target = await this.#parents(false); }
        catch { return retained('CREDENTIAL_COPY_PARENT_UNSAFE'); }
        if (this.#refresh === 'pending') {
          if (this.#copied) {
            try {
              const content = await readPrivate(target, 1024 * 1024);
              this.#remember?.(content);
              const updated = await this.#lease.commitSecret(content, this.#revision);
              this.#refresh = updated.revision === this.#revision ? 'unchanged' : 'updated';
            } catch { this.#refresh = 'failed'; this.#diagnostics.push('CREDENTIAL_REFRESH_FAILED'); }
          } else this.#refresh = 'not_prepared';
        }
        try { await unlink(target); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return retained('CREDENTIAL_COPY_CLEANUP_FAILED'); }
      } else this.#refresh = 'not_prepared';
      try { await this.#lease.release(); }
      catch { return retained('CREDENTIAL_LEASE_RELEASE_FAILED'); }
      this.#released = true;
      this.#result = Object.freeze({ status: 'released', refresh: this.#refresh, credential: this.metadata, diagnostics: Object.freeze([...this.#diagnostics]) });
      return this.#result;
    });
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new CredentialError('UNSAFE_CREDENTIAL_COPY_DIRECTORY');
}
