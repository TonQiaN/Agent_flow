import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import type { CredentialIdentity, ExecutionResource, RunnerResult } from '@agentflow/engine';
import { CredentialError, readPrivate } from './file-store.js';
import type { ExecutionCredentialStore } from './file-store.js';
import type { BindingFinalization, ExecutionCredentialBinding } from './execution-binding.js';
import { stateEnvironment } from '../execution/state-binding.js';

/** The same source-owned finalizer serves normal execution and stopped-resource recovery. */
export class SubscriptionResourceBinding implements ExecutionCredentialBinding {
  readonly environment: Readonly<Record<string, string>>;
  readonly #definition: JsonValue;
  readonly #credential: CredentialIdentity;
  #resource: string | null = null;
  #directory: string | null = null;
  #result: BindingFinalization | null = null;
  #restored = false;
  #copied = false;
  #abandoned = false;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly source: ExecutionCredentialStore, credential: CredentialIdentity, private readonly stateFile: string,
    environment: Readonly<Record<string, string>>, private readonly identity?: ExecutionIdentity, private readonly remember?: (content: string) => void) {
    if (!source || typeof source.executionDefinition !== 'function' || typeof source.acquireExecution !== 'function' || typeof source.finishExecution !== 'function')
      throw new CredentialError('CREDENTIAL_RESOURCE_RESTORE_UNAVAILABLE');
    if (identity && !isExecutionIdentity(identity) || typeof stateFile !== 'string' || stateFile.length > 256 || stateFile.split('/').length > 8
      || !stateFile.split('/').every(part => /^\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) throw new CredentialError('INVALID_CREDENTIAL_BINDING');
    this.identity = identity ? Object.freeze({ ...identity }) : undefined;
    this.#credential = Object.freeze({ ...credential }); this.environment = stateEnvironment(environment);
    this.#definition = { schema: 'agentflow-subscription-resource/v1', credential: { ...credential }, source: source.executionDefinition(), stateFile, environment: { ...this.environment } };
  }
  resourceDefinition(): JsonValue { return structuredClone(this.#definition); }
  #serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.#queue.then(operation); this.#queue = next.catch(() => {}); return next; }
  #own(resource: ExecutionResource, directory: string): void {
    if (this.#resource || this.#abandoned || !/^af-[a-f0-9-]{36}$/.test(resource.id) || !isAbsolute(directory)) throw new CredentialError('BINDING_ALREADY_USED');
    this.#resource = resource.id; this.#directory = directory;
  }
  async restoreResource(resource: ExecutionResource, directory: string): Promise<void> {
    this.#own(resource, directory); this.#restored = true; // No source access or mutation during strict load.
  }
  async #path(create: boolean): Promise<string | null> {
    let cursor = this.#directory!;
    for (const part of ['', ...this.stateFile.split('/').slice(0, -1)]) {
      if (part) { cursor = join(cursor, part); if (create) await mkdir(cursor, { mode: 0o700 }); }
      let info;
      try { info = await lstat(cursor); }
      catch (error) { if (!create && error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new CredentialError('UNSAFE_CREDENTIAL_COPY_DIRECTORY');
    }
    return join(cursor, this.stateFile.split('/').at(-1)!);
  }
  prepare(resource: ExecutionResource, directory: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.identity) throw new CredentialError('RECOVERY_BINDING_CANNOT_EXECUTE');
      this.#own(resource, directory);
      const lease = await this.source.acquireExecution(this.#credential, resource.id);
      const content = await lease.readSecret(); this.remember?.(content);
      const target = (await this.#path(true))!;
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, 'utf8'); await file.sync(); this.#copied = true; } finally { await file.close(); }
    });
  }
  async #finalize(): Promise<BindingFinalization> {
    if (this.#result) return this.#result;
    const path = this.#directory ? await this.#path(false) : null;
    let content: string | null = null;
    if (path) { try { content = await readPrivate(path, 1024 * 1024); this.remember?.(content); } catch { content = null; } }
    const result = await this.source.finishExecution(this.#credential, this.#resource!, !this.#restored && !this.#copied ? undefined : content);
    if (path) { try { await unlink(path); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } }
    this.#result = Object.freeze({ status: 'released', ...result, diagnostics: Object.freeze(result.refresh === 'failed' ? ['CREDENTIAL_REFRESH_FAILED'] : []) });
    return this.#result;
  }
  finish(result: RunnerResult): Promise<BindingFinalization> {
    const proof = structuredClone({ identity: result.identity, resource: result.resource, stop: result.stop, cleanup: result.cleanup });
    return this.#serial(async () => {
      if (!this.identity || Object.entries(this.identity).some(([key, value]) => proof.identity[key as keyof ExecutionIdentity] !== value) || this.#resource !== null && proof.resource?.id !== this.#resource)
        throw new CredentialError('BINDING_EXECUTION_MISMATCH');
      if (proof.resource && (proof.stop !== 'confirmed' || proof.cleanup !== 'removed') || !proof.resource && (proof.stop !== 'not_started' || proof.cleanup !== 'not_created'))
        throw new CredentialError('EXECUTION_NOT_CLEANED');
      // Runner can fail/cancel before prepare. Seal its allocated identity against a delayed preparation.
      if (!this.#resource && proof.resource) this.#resource = proof.resource.id;
      if (!this.#resource) { this.#abandoned = true; return { status: 'released', refresh: 'not_prepared', credential: null, diagnostics: [] }; }
      return this.#finalize();
    });
  }
  beforeRelease(resource: ExecutionResource): Promise<void> {
    return this.#serial(async () => {
      if (this.#resource !== resource.id) throw new CredentialError('BINDING_EXECUTION_MISMATCH');
      if (this.#restored) await this.#finalize(); // DockerBackend calls only after verified removal.
      if (!this.#result) throw new CredentialError('BINDING_NOT_FINALIZED');
    });
  }
  async abandon(): Promise<void> { if (this.#resource) throw new CredentialError('EXECUTION_PROOF_REQUIRED'); this.#abandoned = true; }
}
