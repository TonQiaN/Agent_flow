import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { RunStoreError, snapshotJson } from '@agentflow/engine';
import type { RunRecord, RunRecordStore } from '@agentflow/engine';

const application = 1095124785, version = 1, limit = 16 * 1024 * 1024;
const schema = 'CREATE TABLE run_records (run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID';
const checksum = (runId: string, revision: number, payload: string): string => createHash('sha256').update(JSON.stringify([runId, revision, payload])).digest('hex');
const id = (value: unknown): void => { if (!isIdentifier(value)) throw new RunStoreError('INVALID_RUN_RECORD'); };
const encode = (value: JsonValue): string => {
  let text: string;
  try { text = JSON.stringify(snapshotJson(value)); } catch { throw new RunStoreError('INVALID_RUN_RECORD'); }
  if (Buffer.byteLength(text) > limit) throw new RunStoreError('RUN_RECORD_TOO_LARGE');
  return text;
};
const mapped = (error: unknown): RunStoreError => error instanceof RunStoreError ? error : new RunStoreError('RUN_STORE_IO_ERROR');
async function privatePath(path: string, directory: boolean, absent = false): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new RunStoreError('RUN_STORE_UNSAFE');
  } catch (error) { if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw mapped(error); }
}

/** Single-host state storage. No executor, credentials, artifacts or Docker operations. */
export class SqliteRunRecordStore implements RunRecordStore {
  #closed = false;
  readonly #database: DatabaseSync;
  private constructor(readonly root: string, database: DatabaseSync) { this.#database = database; }
  static async open(root: string): Promise<SqliteRunRecordStore> {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || !process.getuid) throw new RunStoreError('RUN_STORE_UNSAFE');
    let database: DatabaseSync | undefined;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 }); await privatePath(root, true);
      const path = join(root, 'runs.sqlite');
      try {
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.sync(); } finally { await file.close(); }
        const directory = await open(root, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      for (const suffix of ['', '-wal', '-shm', '-journal']) await privatePath(path + suffix, false, suffix !== '');
      // Load the native binding only when the caller actually selects this store.
      const sqlite = await import('node:sqlite'); database = new sqlite.DatabaseSync(path);
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
      database.exec('BEGIN IMMEDIATE');
      try {
        const app = database.prepare('PRAGMA application_id').get()!['application_id'];
        const rev = database.prepare('PRAGMA user_version').get()!['user_version'];
        const entries = database.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
        if (app === 0 && rev === 0 && entries.length === 0) {
          database.exec(schema); database.exec(`PRAGMA application_id = ${application}; PRAGMA user_version = ${version}`);
        } else SqliteRunRecordStore.verify(database);
        database.exec('COMMIT');
      } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
      const journal = database.prepare('PRAGMA journal_mode = WAL').get()!['journal_mode'];
      if (journal !== 'wal') throw new RunStoreError('RUN_STORE_UNSUPPORTED');
      for (const suffix of ['', '-wal', '-shm']) await privatePath(path + suffix, false, suffix !== '');
      return new SqliteRunRecordStore(root, database);
    } catch (error) { try { database?.close(); } catch {} throw mapped(error); }
  }
  private static verify(database: DatabaseSync): void {
    if (database.prepare('PRAGMA application_id').get()!['application_id'] !== application
      || database.prepare('PRAGMA user_version').get()!['user_version'] !== version) throw new RunStoreError('RUN_STORE_UNSUPPORTED');
    const entries = database.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (entries.length !== 1 || entries[0]!['name'] !== 'run_records' || entries[0]!['sql'] !== schema) throw new RunStoreError('RUN_STORE_UNSUPPORTED');
  }
  #ready(): void { if (this.#closed) throw new RunStoreError('RUN_STORE_CLOSED'); SqliteRunRecordStore.verify(this.#database); }
  #load(runId: string): RunRecord | null {
    const row = this.#database.prepare('SELECT revision, payload, digest FROM run_records WHERE run_id = ?').get(runId);
    if (!row) return null;
    const revision = row['revision'], payload = row['payload'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || typeof payload !== 'string' || Buffer.byteLength(payload) > limit
      || row['digest'] !== checksum(runId, revision, payload)) throw new RunStoreError('RUN_STORE_CORRUPT');
    let content: JsonValue;
    try { content = snapshotJson(JSON.parse(payload)); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    return { runId, revision, content };
  }
  #transaction<T>(operation: () => T): T {
    this.#ready(); this.#database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#database.exec('COMMIT'); return result; }
    catch (error) { try { this.#database.exec('ROLLBACK'); } catch {} throw error; }
  }
  async create(runId: string, content: JsonValue): Promise<RunRecord> {
    id(runId); const payload = encode(content);
    try { return this.#transaction(() => {
      if (this.#load(runId)) throw new RunStoreError('RUN_ALREADY_EXISTS');
      this.#database.prepare('INSERT INTO run_records (run_id, revision, payload, digest) VALUES (?, ?, ?, ?)').run(runId, 1, payload, checksum(runId, 1, payload));
      return { runId, revision: 1, content: JSON.parse(payload) as JsonValue };
    }); } catch (error) { throw mapped(error); }
  }
  async read(runId: string): Promise<RunRecord | null> {
    id(runId); try { this.#ready(); return this.#load(runId); } catch (error) { throw mapped(error); }
  }
  async compareAndSwap(runId: string, expectedRevision: number, content: JsonValue): Promise<RunRecord> {
    id(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new RunStoreError('INVALID_RUN_RECORD');
    const payload = encode(content);
    try { return this.#transaction(() => {
      const current = this.#load(runId); if (!current) throw new RunStoreError('RUN_NOT_FOUND');
      if (current.revision !== expectedRevision) throw new RunStoreError('RUN_REVISION_CONFLICT');
      const revision = expectedRevision + 1;
      const result = this.#database.prepare('UPDATE run_records SET revision = ?, payload = ?, digest = ? WHERE run_id = ? AND revision = ?')
        .run(revision, payload, checksum(runId, revision, payload), runId, expectedRevision);
      if (result.changes !== 1) throw new RunStoreError('RUN_REVISION_CONFLICT');
      return { runId, revision, content: JSON.parse(payload) as JsonValue };
    }); } catch (error) { throw mapped(error); }
  }
  close(): void { if (this.#closed) return; try { this.#database.close(); this.#closed = true; } catch (error) { throw mapped(error); } }
}
