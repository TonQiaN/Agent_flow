import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isIdentifier } from '@agentflow/domain';
import type { CredentialIdentity, CredentialLease, CredentialMetadata, CredentialSource, CredentialStore } from '@agentflow/engine';

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
export class FileCredentialStore implements CredentialStore {
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
    try { raw = await readPrivate(this.#path(identity), LIMIT * 7); }
    catch (error) { if (nodeError(error, 'ENOENT')) return null; throw error; }
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

  async #replace(stored: StoredCredential): Promise<void> {
    const temporary = join(this.#root, `.credential-${randomUUID()}.tmp`);
    try {
      await writeNew(temporary, JSON.stringify(stored));
      await rename(temporary, this.#path(stored));
      // Rename provides readers atomic old/new contents. Directory fsync makes the rename durable on supported POSIX filesystems.
      const directory = await open(this.#root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
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
      const lock = await this.#lock(selected, waitMs);
      try {
        const previous = await this.#read(selected);
        if (previous?.payload === content) return metadata(previous);
        if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new CredentialError('CREDENTIAL_REVISION_EXHAUSTED');
        const stored: StoredCredential = { ...selected, schema: 1, generation: previous?.generation ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, payload: content };
        await this.#replace(stored);
        return metadata(stored);
      } finally { await lock.release(); }
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
            if (current.payload === content) return metadata(current);
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
        if (stored) await unlink(this.#path(selected));
        return { deleted: stored !== null, remoteRevoked: false };
      } finally { await lock.release(); }
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

async function writeNew(path: string, text: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
}

/** Internal shared bounded reader; callers must first validate their controlled parent directories. */
export async function readPrivate(path: string, limit: number): Promise<string> {
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
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new CredentialError('INVALID_CREDENTIAL_ENCODING'); }
  } finally { await file.close(); }
}
