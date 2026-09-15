import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import type { CredentialIdentity, CredentialLease, CredentialMetadata, CredentialSource, CredentialManagementStore, CredentialManagementLease, CredentialRecoveryStore, CredentialRecoveryResult } from '@agentflow/engine';

export interface CredentialCodec {
  readonly service: string;
  readonly method: string;
  /** Local format validation only. Must not perform remote calls or imply token validity. */
  validate(content: string): boolean;
  /** Optional local refresh identity check. Explicit administrative configure is separate. */
  validateRefresh?(previous: string, next: string): boolean;
}
export class CredentialError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CredentialError'; }
}
interface StoredCredential extends CredentialIdentity { schema: 1; generation: string; revision: number; payload: string }
interface Lock { release(): Promise<void> }
export interface ExecutionCredentialFinalization {
  readonly credential: CredentialMetadata | null;
  readonly refresh: 'not_prepared' | 'unchanged' | 'updated' | 'failed';
}
/** Trusted resource management only; finalize only after the owning execution is stopped and removed. */
export interface ExecutionCredentialStore {
  executionDefinition(): JsonValue;
  acquireExecution(identity: CredentialIdentity, resource: string): Promise<{ metadata: CredentialMetadata; readSecret(): Promise<string> }>;
  /** undefined means the current host proves no copy was prepared; null is missing/invalid recovery content. */
  finishExecution(identity: CredentialIdentity, resource: string, content: string | null | undefined): Promise<ExecutionCredentialFinalization>;
}
interface ExecutionOwner { nonce: string; pid: number; execution: string; credential: CredentialMetadata }
type SecretReader = (expected: CredentialMetadata) => Promise<string>;
type SecretCommitter = (expected: CredentialMetadata, content: string) => Promise<CredentialMetadata>;
const LIMIT = 1024 * 1024;
const metadata = (stored: StoredCredential): CredentialMetadata => Object.freeze({ credentialRef: stored.credentialRef, service: stored.service,
  method: stored.method, generation: stored.generation, revision: stored.revision, remoteStatus: 'unknown' });
const validIdentity = (identity: CredentialIdentity): boolean => !!identity && Object.keys(identity).length === 3
  && isIdentifier(identity.credentialRef) && isIdentifier(identity.service) && isIdentifier(identity.method);
const nodeError = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw error instanceof CredentialError ? error : new CredentialError('CREDENTIAL_STORAGE_ERROR'); }
}

/** POSIX, current-user local storage. Ancestors outside root must be controlled by the host. */
export class FileCredentialStore implements CredentialManagementStore, CredentialRecoveryStore, ExecutionCredentialStore {
  readonly #root: string;
  readonly #codecs = new Map<string, CredentialCodec>();

  constructor(root: string, codecs: readonly CredentialCodec[]) {
    if (!isAbsolute(root) || root.includes('\0') || !process.getuid || process.getuid() === 0) throw new CredentialError('INVALID_CREDENTIAL_STORE');
    this.#root = root;
    for (const codec of codecs) {
      const key = `${codec.service}/${codec.method}`;
      if (!isIdentifier(codec.service) || !isIdentifier(codec.method) || typeof codec.validate !== 'function' || this.#codecs.has(key)) throw new CredentialError('INVALID_CREDENTIAL_CODEC');
      this.#codecs.set(key, codec);
    }
  }

  #codec(identity: CredentialIdentity): CredentialCodec {
    if (!validIdentity(identity)) throw new CredentialError('INVALID_CREDENTIAL_IDENTITY');
    const codec = this.#codecs.get(`${identity.service}/${identity.method}`);
    if (!codec) throw new CredentialError('UNSUPPORTED_CREDENTIAL_METHOD');
    return codec;
  }
  #validate(identity: CredentialIdentity, content: string): void {
    const codec = this.#codec(identity);
    let valid = false;
    try { valid = typeof content === 'string' && content.length > 0 && Buffer.byteLength(content) <= LIMIT && codec.validate(content) === true; } catch { /* A provider error must not echo the credential. */ }
    if (!valid) throw new CredentialError('INVALID_CREDENTIAL_CONTENT');
  }
  #path(identity: CredentialIdentity): string { return join(this.#root, `${identity.credentialRef}.json`); }
  #backupPath(identity: CredentialIdentity): string { return join(this.#root, `.backup-${identity.credentialRef}.json`); }
  #serialize(stored: StoredCredential): string {
    return JSON.stringify({ schema: 1, credentialRef: stored.credentialRef, service: stored.service, method: stored.method,
      generation: stored.generation, revision: stored.revision, payload: stored.payload });
  }

  async #rootReady(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) throw new CredentialError('UNSAFE_CREDENTIAL_DIRECTORY');
  }

  async #lock(identity: CredentialIdentity, waitMs: number): Promise<Lock> {
    this.#codec(identity);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new CredentialError('INVALID_CREDENTIAL_WAIT');
    await this.#rootReady();
    const lockPath = join(this.#root, `${identity.credentialRef}.lock`);
    const deadline = performance.now() + waitMs;
    const nonce = randomUUID();
    while (true) {
      try { await mkdir(lockPath, { mode: 0o700 }); break; }
      catch (error) {
        if (!nodeError(error, 'EEXIST')) throw error;
        let info;
        try { info = await lstat(lockPath); }
        catch (inspectionError) { if (nodeError(inspectionError, 'ENOENT')) continue; throw inspectionError; }
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) throw new CredentialError('UNSAFE_CREDENTIAL_LOCK');
        if (performance.now() >= deadline) throw new CredentialError('CREDENTIAL_BUSY');
        await delay(Math.min(25, Math.max(1, deadline - performance.now())));
      }
    }
    // A crash before/after writing owner.json leaves the lock in place. PID death is not container-stop evidence.
    const ownerFile = join(lockPath, 'owner.json');
    try { await writeNew(ownerFile, JSON.stringify({ nonce, pid: process.pid })); }
    catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
    let released = false;
    return { release: async () => safe(async () => {
      if (released) return;
      const owner = JSON.parse(await readPrivate(ownerFile, 1024)) as { nonce?: unknown };
      if (owner.nonce !== nonce) throw new CredentialError('CREDENTIAL_LOCK_OWNERSHIP_LOST');
      await rm(lockPath, { recursive: true });
      released = true;
    }) };
  }

  async #read(identity: CredentialIdentity): Promise<StoredCredential | null> {
    this.#codec(identity);
    await this.#rootReady();
    let raw: string;
    try { raw = await readPrivate(this.#path(identity), LIMIT * 7, true); }
    catch (error) { if (nodeError(error, 'ENOENT')) return null; throw error; }
    return this.#parse(identity, raw);
  }

  #parse(identity: CredentialIdentity, raw: string): StoredCredential {
    let stored: StoredCredential;
    try { stored = JSON.parse(raw) as StoredCredential; } catch { throw new CredentialError('CORRUPT_CREDENTIAL_RECORD'); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.schema !== 1
      || Object.keys(stored).sort().join(',') !== 'credentialRef,generation,method,payload,revision,schema,service'
      || typeof stored.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(stored.generation)
      || !Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new CredentialError('CORRUPT_CREDENTIAL_RECORD');
    if (stored.credentialRef !== identity.credentialRef || stored.service !== identity.service || stored.method !== identity.method) throw new CredentialError('CREDENTIAL_IDENTITY_MISMATCH');
    this.#validate(identity, stored.payload);
    return stored;
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async #atomicWrite(path: string, text: string): Promise<void> {
    const temporary = join(this.#root, `.credential-${randomUUID()}.tmp`);
    try { await writeNew(temporary, text); await rename(temporary, path); await this.#syncDirectory(); }
    finally { await rm(temporary, { force: true }); }
  }
  async #checkBackupFile(identity: CredentialIdentity): Promise<void> {
    try {
      const info = await lstat(this.#backupPath(identity));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600)
        throw new CredentialError('UNSAFE_CREDENTIAL_BACKUP');
    } catch (error) { if (!nodeError(error, 'ENOENT')) throw error; }
  }
  async #invalidateBackup(identity: CredentialIdentity): Promise<void> {
    await this.#checkBackupFile(identity);
    try { await unlink(this.#backupPath(identity)); } catch (error) { if (!nodeError(error, 'ENOENT')) throw error; }
    // The invalidation must precede a new generation/revision or local deletion durably.
    await this.#syncDirectory();
  }
  async #checkpoint(stored: StoredCredential): Promise<void> {
    const serialized = this.#serialize(stored);
    const live = await readPrivate(this.#path(stored), LIMIT * 7, true);
    if (live !== serialized) {
      if (this.#serialize(this.#parse({ credentialRef: stored.credentialRef, service: stored.service, method: stored.method }, live)) !== serialized) throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
      // Normalize an existing valid envelope before checkpointing so a torn prefix is identifiable.
      await this.#invalidateBackup(stored);
      await this.#atomicWrite(this.#path(stored), serialized);
    }
    await this.#checkBackupFile(stored);
    await this.#atomicWrite(this.#backupPath(stored), serialized);
  }
  async #replace(stored: StoredCredential): Promise<void> {
    await this.#invalidateBackup(stored);
    await this.#atomicWrite(this.#path(stored), this.#serialize(stored));
    await this.#checkpoint(stored);
  }

  async recover(identity: CredentialIdentity, waitMs = 0): Promise<CredentialRecoveryResult> {
    this.#codec(identity); const selected = Object.freeze({ ...identity });
    return safe(async () => {
      const lock = await this.#lock(selected, waitMs);
      try {
        let raw: string;
        try { raw = await readPrivate(this.#path(selected), LIMIT * 7, true); }
        catch (error) {
          if (nodeError(error, 'ENOENT')) return { status: 'not_configured', credential: null, diagnostic: 'RECOVERY_LIVE_MISSING' };
          throw error;
        }
        try { return { status: 'healthy', credential: metadata(this.#parse(selected, raw)), diagnostic: null }; }
        catch (error) {
          if (!(error instanceof CredentialError) || !['CORRUPT_CREDENTIAL_RECORD', 'INVALID_CREDENTIAL_CONTENT'].includes(error.code)) throw error;
        }
        const unavailable = (diagnostic: string): CredentialRecoveryResult => ({ status: 'unavailable', credential: null, diagnostic });
        // Parseable but unknown/schema-invalid content is not evidence of a torn write.
        try { JSON.parse(raw); return unavailable('RECOVERY_FORMAT_NOT_RECOGNIZED'); } catch { /* Strict prefix check below. */ }
        let backup: string;
        try { backup = await readPrivate(this.#backupPath(selected), LIMIT * 7, true); }
        catch (error) { if (nodeError(error, 'ENOENT')) return unavailable('RECOVERY_BACKUP_MISSING'); throw error; }
        let stored: StoredCredential;
        try { stored = this.#parse(selected, backup); }
        catch { return unavailable('RECOVERY_BACKUP_INVALID'); }
        if (backup !== this.#serialize(stored)) return unavailable('RECOVERY_BACKUP_FORMAT_NOT_RECOGNIZED');
        const headerLength = backup.indexOf(',"payload":') + ',"payload":'.length;
        if (headerLength < 1 || raw.length < headerLength || raw.length >= backup.length || !backup.startsWith(raw))
          return unavailable('RECOVERY_PREFIX_OR_VERSION_MISMATCH');
        if (await readPrivate(this.#path(selected), LIMIT * 7, true) !== raw) throw new CredentialError('CREDENTIAL_RECOVERY_CONFLICT');
        // The matching backup remains intact if restoring the live file fails.
        await this.#atomicWrite(this.#path(selected), backup);
        return { status: 'restored', credential: metadata(stored), diagnostic: null };
      } finally { await lock.release(); }
    });
  }

  async configure(identity: CredentialIdentity, source: CredentialSource, waitMs = 0): Promise<CredentialMetadata> {
    // Snapshot public identity before any await; caller mutation must not redirect a held lock.
    this.#codec(identity);
    const selected = Object.freeze({ ...identity });
    return safe(async () => {
      if (!source || typeof source !== 'object' || Object.keys(source).length !== 1
        || !Object.hasOwn(source, 'content') && !Object.hasOwn(source, 'file')) throw new CredentialError('CONFLICTING_CREDENTIAL_SOURCES');
      let content: string;
      if ('content' in source && typeof source.content === 'string') content = source.content;
      else if ('file' in source && typeof source.file === 'string' && isAbsolute(source.file)) content = await readPrivate(source.file, LIMIT);
      else throw new CredentialError('INVALID_CREDENTIAL_SOURCE');
      this.#validate(selected, content);
      const lease = await this.acquireManagement(selected, waitMs);
      try { return await lease.configure(content); } finally { await lease.release(); }
    });
  }

  async acquireManagement(identity: CredentialIdentity, waitMs = 0): Promise<CredentialManagementLease> {
    this.#codec(identity);
    const selected = Object.freeze({ ...identity });
    return safe(async () => {
      const lock = await this.#lock(selected, waitMs);
      try {
        const initial = await this.#read(selected);
        return new FileManagementLease(initial ? metadata(initial) : null, lock, async (expected, content) => {
          this.#validate(selected, content);
          const current = await this.#read(selected);
          if (expected ? !current || current.generation !== expected.generation || current.revision !== expected.revision : current !== null)
            throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
          if (current?.payload === content) { await this.#checkpoint(current); return metadata(current); }
          if (current?.revision === Number.MAX_SAFE_INTEGER) throw new CredentialError('CREDENTIAL_REVISION_EXHAUSTED');
          const stored: StoredCredential = { ...selected, schema: 1, generation: current?.generation ?? randomUUID(), revision: (current?.revision ?? 0) + 1, payload: content };
          await this.#replace(stored); return metadata(stored);
        });
      } catch (error) { await lock.release(); throw error; }
    });
  }

  async inspect(identity: CredentialIdentity): Promise<CredentialMetadata | null> {
    this.#codec(identity);
    const selected = Object.freeze({ ...identity });
    return safe(async () => { const stored = await this.#read(selected); return stored ? metadata(stored) : null; });
  }

  async acquire(identity: CredentialIdentity, waitMs = 0): Promise<CredentialLease> {
    this.#codec(identity);
    const selected = Object.freeze({ ...identity });
    return safe(async () => {
      const lock = await this.#lock(selected, waitMs);
      try {
        const stored = await this.#read(selected);
        if (!stored) throw new CredentialError('CREDENTIAL_NOT_CONFIGURED');
        const check = async (expected: CredentialMetadata): Promise<StoredCredential> => {
          const current = await this.#read(selected);
          if (!current || current.generation !== expected.generation || current.revision !== expected.revision) throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
          return current;
        };
        return new FileLease(metadata(stored), lock, async expected => (await check(expected)).payload,
          async (expected, content) => {
            this.#validate(selected, content);
            const current = await check(expected);
            const codec = this.#codec(selected); const refresh = codec.validateRefresh;
            if (refresh) {
              let accepted = false;
              try { accepted = refresh.call(codec, current.payload, content) === true; } catch { /* Do not expose provider errors. */ }
              if (!accepted) throw new CredentialError('CREDENTIAL_REFRESH_REJECTED');
            }
            if (current.payload === content) { await this.#checkpoint(current); return metadata(current); }
            if (current.revision === Number.MAX_SAFE_INTEGER) throw new CredentialError('CREDENTIAL_REVISION_EXHAUSTED');
            const updated = { ...current, payload: content, revision: current.revision + 1 };
            await this.#replace(updated);
            return metadata(updated);
          });
      } catch (error) { await lock.release(); throw error; }
    });
  }

  async delete(identity: CredentialIdentity, waitMs = 0): Promise<{ deleted: boolean; remoteRevoked: false }> {
    this.#codec(identity);
    const selected = Object.freeze({ ...identity });
    return safe(async () => {
      const lock = await this.#lock(selected, waitMs);
      try {
        const stored = await this.#read(selected);
        await this.#invalidateBackup(selected);
        if (stored) { await unlink(this.#path(selected)); await this.#syncDirectory(); }
        return { deleted: stored !== null, remoteRevoked: false };
      } finally { await lock.release(); }
    });
  }

  executionDefinition(): { schema: 'agentflow-file-credential-source/v1'; root: string } {
    return { schema: 'agentflow-file-credential-source/v1', root: this.#root };
  }
  #executionPath(identity: CredentialIdentity, resource: string): string {
    this.#codec(identity);
    if (!/^af-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(resource)) throw new CredentialError('INVALID_CREDENTIAL_EXECUTION');
    return join(this.#root, `.execution-${identity.credentialRef}-${resource}.json`);
  }
  async #executionOperation<T>(identity: CredentialIdentity, operation: () => Promise<T>): Promise<T> {
    return safe(async () => {
      await this.#rootReady();
      const guard = join(this.#root, `.${identity.credentialRef}.execution-operation.lock`);
      try { await mkdir(guard, { mode: 0o700 }); }
      catch (error) { if (nodeError(error, 'EEXIST')) throw new CredentialError('CREDENTIAL_OPERATION_BUSY'); throw error; }
      // A killed operation retains this guard. Never infer transaction completion from PID death.
      try { return await operation(); } finally { await rm(guard, { recursive: true }); }
    });
  }
  async #executionOwner(identity: CredentialIdentity): Promise<ExecutionOwner | null> {
    const directory = join(this.#root, `${identity.credentialRef}.lock`);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) throw new CredentialError('UNSAFE_CREDENTIAL_LOCK');
    } catch (error) { if (nodeError(error, 'ENOENT')) return null; throw error; }
    const owner = JSON.parse(await readPrivate(join(directory, 'owner.json'), 4096)) as ExecutionOwner;
    if (!owner || Object.keys(owner).sort().join(',') !== 'credential,execution,nonce,pid' || typeof owner.nonce !== 'string'
      || !/^[a-f0-9-]{36}$/.test(owner.nonce) || !owner.credential
      || Object.keys(owner.credential).sort().join(',') !== 'credentialRef,generation,method,remoteStatus,revision,service'
      || owner.credential.credentialRef !== identity.credentialRef || owner.credential.service !== identity.service || owner.credential.method !== identity.method
      || owner.credential.remoteStatus !== 'unknown' || !/^[a-f0-9-]{36}$/.test(owner.credential.generation)
      || !Number.isSafeInteger(owner.credential.revision) || owner.credential.revision < 1) throw new CredentialError('CREDENTIAL_EXECUTION_OWNERSHIP_UNKNOWN');
    this.#executionPath(identity, owner.execution); return owner;
  }
  async #executionClosed(path: string, identity: CredentialIdentity): Promise<ExecutionCredentialFinalization | null> {
    let raw: string;
    try { raw = await readPrivate(path, 4096); } catch (error) { if (nodeError(error, 'ENOENT')) return null; throw error; }
    const value = JSON.parse(raw) as ExecutionCredentialFinalization;
    if (!value || Object.keys(value).sort().join(',') !== 'credential,refresh'
      || !['not_prepared', 'unchanged', 'updated', 'failed'].includes(value.refresh)
      || (value.credential === null ? value.refresh !== 'not_prepared' : !value.credential
        || Object.keys(value.credential).sort().join(',') !== 'credentialRef,generation,method,remoteStatus,revision,service'
        || value.credential.credentialRef !== identity.credentialRef || value.credential.service !== identity.service || value.credential.method !== identity.method
        || value.credential.remoteStatus !== 'unknown' || !/^[a-f0-9-]{36}$/.test(value.credential.generation)
        || !Number.isSafeInteger(value.credential.revision) || value.credential.revision < 1)) throw new CredentialError('CORRUPT_CREDENTIAL_EXECUTION_RESULT');
    return value;
  }
  async acquireExecution(identity: CredentialIdentity, resource: string): Promise<{ metadata: CredentialMetadata; readSecret(): Promise<string> }> {
    const selected = Object.freeze({ ...identity }), closed = this.#executionPath(selected, resource);
    return this.#executionOperation(selected, async () => {
      if (await this.#executionClosed(closed, selected)) throw new CredentialError('CREDENTIAL_EXECUTION_CLOSED');
      const lock = await this.#lock(selected, 0);
      let stored: StoredCredential;
      try {
        const value = await this.#read(selected);
        if (!value) throw new CredentialError('CREDENTIAL_NOT_CONFIGURED');
        stored = value;
        const ownerPath = join(this.#root, `${selected.credentialRef}.lock`, 'owner.json');
        const owner = JSON.parse(await readPrivate(ownerPath, 1024)) as { nonce: string; pid: number };
        await this.#atomicWrite(ownerPath, JSON.stringify({ ...owner, execution: resource, credential: metadata(stored) }));
        const directory = await open(join(this.#root, `${selected.credentialRef}.lock`), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { await lock.release(); throw error; }
      const expected = metadata(stored);
      return Object.freeze({ metadata: expected, readSecret: () => this.#executionOperation(selected, async () => {
        if (await this.#executionClosed(closed, selected)) throw new CredentialError('CREDENTIAL_EXECUTION_CLOSED');
        const owner = await this.#executionOwner(selected);
        if (!owner || owner.execution !== resource) throw new CredentialError('CREDENTIAL_LOCK_OWNERSHIP_LOST');
        const current = await this.#read(selected);
        if (!current || current.generation !== expected.generation || current.revision !== expected.revision) throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
        return current.payload;
      }) });
    });
  }
  async finishExecution(identity: CredentialIdentity, resource: string, content: string | null | undefined): Promise<ExecutionCredentialFinalization> {
    const selected = Object.freeze({ ...identity }), path = this.#executionPath(selected, resource);
    return this.#executionOperation(selected, async () => {
      const closed = await this.#executionClosed(path, selected);
      if (closed) {
        // A receipt precedes unlock. After later configure/delete, do not inspect or rewrite source bytes.
        try {
          const owner = await this.#executionOwner(selected);
          if (owner?.execution === resource) { await rm(join(this.#root, `${selected.credentialRef}.lock`), { recursive: true }); await this.#syncDirectory(); }
        } catch (error) { if (!(error instanceof CredentialError) || error.code !== 'CREDENTIAL_EXECUTION_OWNERSHIP_UNKNOWN') throw error; }
        return closed;
      }
      const owner = await this.#executionOwner(selected);
      if (owner && owner.execution !== resource) throw new CredentialError('CREDENTIAL_LOCK_OWNERSHIP_LOST');
      let result: ExecutionCredentialFinalization = { credential: null, refresh: 'not_prepared' };
      if (owner) {
        const current = await this.#read(selected), expected = owner.credential;
        if (!current || current.generation !== expected.generation || current.revision !== expected.revision) throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
        result = { credential: metadata(current), refresh: content === undefined ? 'not_prepared' : 'failed' };
        if (typeof content === 'string') {
          let accepted = false;
          try { this.#validate(selected, content); const codec = this.#codec(selected); accepted = !codec.validateRefresh || codec.validateRefresh(current.payload, content) === true; } catch { /* Static failed result, no secret diagnostics. */ }
          if (accepted) {
            if (current.payload === content) result = { credential: metadata(current), refresh: 'unchanged' };
            else {
              if (current.revision === Number.MAX_SAFE_INTEGER) throw new CredentialError('CREDENTIAL_REVISION_EXHAUSTED');
              const updated = { ...current, payload: content, revision: current.revision + 1 };
              await this.#replace(updated); result = { credential: metadata(updated), refresh: 'updated' };
            }
          }
        }
      }
      await this.#atomicWrite(path, JSON.stringify(result));
      if (owner) { await rm(join(this.#root, `${selected.credentialRef}.lock`), { recursive: true }); await this.#syncDirectory(); }
      return result;
    });
  }
}

/** Secrets live behind methods, not enumerable result fields. Operations on one lease are serialized too. */
class FileLease implements CredentialLease {
  #metadata: CredentialMetadata;
  #released = false;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #lock: Lock;
  readonly #read: SecretReader;
  readonly #commit: SecretCommitter;
  constructor(info: CredentialMetadata, lock: Lock, read: SecretReader, commit: SecretCommitter) {
    this.#metadata = info; this.#lock = lock; this.#read = read; this.#commit = commit;
  }
  get metadata(): CredentialMetadata { return this.#metadata; }
  toJSON(): CredentialMetadata { return this.#metadata; }
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => safe(operation));
    this.#queue = next.catch(() => undefined);
    return next;
  }
  #active(): void { if (this.#released) throw new CredentialError('CREDENTIAL_LEASE_RELEASED'); }
  readSecret(): Promise<string> { return this.#exclusive(async () => { this.#active(); return this.#read(this.#metadata); }); }
  commitSecret(content: string, expectedRevision: number): Promise<CredentialMetadata> {
    return this.#exclusive(async () => {
      this.#active();
      if (expectedRevision !== this.#metadata.revision) throw new CredentialError('CREDENTIAL_REVISION_CONFLICT');
      this.#metadata = await this.#commit(this.#metadata, content); return this.#metadata;
    });
  }
  release(): Promise<void> {
    return this.#exclusive(async () => { if (!this.#released) { await this.#lock.release(); this.#released = true; } });
  }
}

class FileManagementLease implements CredentialManagementLease {
  #metadata: CredentialMetadata | null;
  #released = false;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #lock: Lock;
  readonly #commit: (expected: CredentialMetadata | null, content: string) => Promise<CredentialMetadata>;
  constructor(initial: CredentialMetadata | null, lock: Lock, commit: (expected: CredentialMetadata | null, content: string) => Promise<CredentialMetadata>) {
    this.#metadata = initial; this.#lock = lock; this.#commit = commit;
  }
  get metadata(): CredentialMetadata | null { return this.#metadata; }
  toJSON(): { credential: CredentialMetadata | null; released: boolean } { return { credential: this.#metadata, released: this.#released }; }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => safe(operation)); this.#queue = next.catch(() => undefined); return next;
  }
  configure(content: string): Promise<CredentialMetadata> {
    return this.#serial(async () => {
      if (this.#released) throw new CredentialError('CREDENTIAL_LEASE_RELEASED');
      this.#metadata = await this.#commit(this.#metadata, content); return this.#metadata;
    });
  }
  release(): Promise<void> {
    return this.#serial(async () => { if (!this.#released) { await this.#lock.release(); this.#released = true; } });
  }
}

async function writeNew(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
}

/** Internal shared bounded reader; callers must first validate their controlled parent directories. */
export async function readPrivate(path: string, limit: number, preserveBOM = false): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
    || (before.mode & 0o777) !== 0o600 || before.size > limit) throw new CredentialError('UNSAFE_CREDENTIAL_FILE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size
      || opened.uid !== before.uid || opened.mode !== before.mode || opened.nlink !== 1) throw new CredentialError('CREDENTIAL_FILE_CHANGED');
    const bytes = Buffer.alloc(Math.min(limit + 1, opened.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new CredentialError('CREDENTIAL_FILE_CHANGED');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBOM }).decode(bytes.subarray(0, length)); }
    catch { throw new CredentialError('INVALID_CREDENTIAL_ENCODING'); }
  } finally { await file.close(); }
}
