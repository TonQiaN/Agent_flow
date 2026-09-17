import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { RunStoreError, snapshotJson } from '@agentflow/engine';
import type { RunRecord, AtomicRunRecordStore } from '@agentflow/engine';

const application = 1095124785, version = 2, limit = 16 * 1024 * 1024;
const schema = 'CREATE TABLE run_records (run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL, digest TEXT NOT NULL) WITHOUT ROWID';
const historySchema = 'CREATE TABLE run_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, revision INTEGER NOT NULL, recorded_at INTEGER, payload TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(run_id, revision))';
const eventSchema = 'CREATE TABLE run_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL)';
export interface RunRevision extends RunRecord { readonly sequence: number; readonly recordedAt: number | null }
export interface RunEvent { readonly sequence: number; readonly runId: string; readonly recordedAt: number; readonly content: JsonValue }
export interface RecordPage { readonly after?: string; readonly limit?: number }
const pageLimit = (value = 100): number => { if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new RunStoreError('INVALID_RUN_RECORD'); return value; };
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
export class SqliteRunRecordStore implements AtomicRunRecordStore {
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
          database.exec(schema); database.exec(historySchema); database.exec(eventSchema); database.exec(`PRAGMA application_id = ${application}; PRAGMA user_version = ${version}`);
        } else if (app === application && rev === 1 && entries.length === 1 && entries[0]!['sql'] === schema) {
          database.exec(historySchema); database.exec(eventSchema);
          // No timestamp or missing revisions can be reconstructed from a v1 latest-value row.
          database.exec('INSERT INTO run_history (run_id, revision, recorded_at, payload, digest) SELECT run_id, revision, NULL, payload, digest FROM run_records');
          database.exec(`PRAGMA user_version = ${version}`);
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
    const expected = new Map([['run_records', schema], ['run_history', historySchema], ['run_events', eventSchema]]);
    if (entries.length !== expected.size || entries.some(entry => entry['sql'] !== expected.get(String(entry['name'])))) throw new RunStoreError('RUN_STORE_UNSUPPORTED');
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
  #history(runId: string, revision: number, payload: string): void {
    this.#database.prepare('INSERT INTO run_history (run_id, revision, recorded_at, payload, digest) VALUES (?, ?, ?, ?, ?)')
      .run(runId, revision, Date.now(), payload, checksum(runId, revision, payload));
  }
  /** Stable keyset pagination, including non-workflow records. Consumers must project their own schema. */
  async list(options: RecordPage = {}): Promise<readonly RunRecord[]> {
    const count = pageLimit(options.limit);
    if (options.after !== undefined) id(options.after);
    try {
      this.#ready();
      return this.#database.prepare('SELECT run_id FROM run_records WHERE run_id > ? ORDER BY run_id LIMIT ?').all(options.after ?? '', count)
        .map(row => this.#load(String(row['run_id']))!);
    } catch (error) { throw mapped(error); }
  }
  async history(runId: string, after = 0, count = 100): Promise<readonly RunRevision[]> {
    id(runId); pageLimit(count);
    if (!Number.isSafeInteger(after) || after < 0) throw new RunStoreError('INVALID_RUN_RECORD');
    try {
      this.#ready();
      return this.#database.prepare('SELECT sequence, revision, recorded_at, payload, digest FROM run_history WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(runId, after, count).map(row => {
          const revision = Number(row['revision']), payload = String(row['payload']);
          if (row['digest'] !== checksum(runId, revision, payload)) throw new RunStoreError('RUN_STORE_CORRUPT');
          return { runId, revision, sequence: Number(row['sequence']), recordedAt: row['recorded_at'] === null ? null : Number(row['recorded_at']), content: snapshotJson(JSON.parse(payload)) };
        });
    } catch (error) { throw mapped(error); }
  }
  /** Read one saved revision without decoding every earlier payload. */
  async revision(runId: string, revision: number): Promise<RunRevision | null> {
    id(runId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RunStoreError('INVALID_RUN_RECORD');
    try {
      this.#ready();
      return this.#revisionRow(runId, this.#database.prepare('SELECT sequence, revision, recorded_at, payload, digest FROM run_history WHERE run_id = ? AND revision = ?').get(runId, revision));
    } catch (error) { throw mapped(error); }
  }
  /** Unknown legacy timestamps cannot participate in a wall-clock replay. */
  async revisionAt(runId: string, recordedAt: number, throughSequence = Number.MAX_SAFE_INTEGER): Promise<RunRevision | null> {
    id(runId);
    if (!Number.isSafeInteger(recordedAt) || recordedAt < 0 || !Number.isSafeInteger(throughSequence) || throughSequence < 1) throw new RunStoreError('INVALID_RUN_RECORD');
    try {
      this.#ready();
      return this.#revisionRow(runId, this.#database.prepare('SELECT sequence, revision, recorded_at, payload, digest FROM run_history WHERE run_id = ? AND recorded_at <= ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1').get(runId, recordedAt, throughSequence));
    } catch (error) { throw mapped(error); }
  }
  #revisionRow(runId: string, row: Record<string, unknown> | undefined): RunRevision | null {
    if (!row) return null;
    const revision = Number(row['revision']), payload = String(row['payload']);
    if (row['digest'] !== checksum(runId, revision, payload)) throw new RunStoreError('RUN_STORE_CORRUPT');
    return { runId, revision, sequence: Number(row['sequence']), recordedAt: row['recorded_at'] === null ? null : Number(row['recorded_at']), content: snapshotJson(JSON.parse(payload)) };
  }
  /** The caller provides already-redacted event data, never credentials or raw private state. */
  async appendEvent(runId: string, content: JsonValue): Promise<RunEvent> {
    id(runId); const payload = encode(content);
    try { return this.#transaction(() => {
      const recordedAt = Date.now();
      const result = this.#database.prepare('INSERT INTO run_events (run_id, recorded_at, payload, digest) VALUES (?, ?, ?, ?)')
        .run(runId, recordedAt, payload, checksum(runId, recordedAt, payload));
      return { runId, sequence: Number(result.lastInsertRowid), recordedAt, content: snapshotJson(JSON.parse(payload)) };
    }); } catch (error) { throw mapped(error); }
  }
  async events(runId: string, after = 0, count = 100): Promise<readonly RunEvent[]> {
    id(runId); pageLimit(count);
    if (!Number.isSafeInteger(after) || after < 0) throw new RunStoreError('INVALID_RUN_RECORD');
    try {
      this.#ready();
      return this.#database.prepare('SELECT sequence, recorded_at, payload, digest FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(runId, after, count).map(row => {
          const recordedAt = Number(row['recorded_at']), payload = String(row['payload']);
          if (row['digest'] !== checksum(runId, recordedAt, payload)) throw new RunStoreError('RUN_STORE_CORRUPT');
          return { runId, sequence: Number(row['sequence']), recordedAt, content: snapshotJson(JSON.parse(payload)) };
        });
    } catch (error) { throw mapped(error); }
  }
  async create(runId: string, content: JsonValue): Promise<RunRecord> {
    id(runId); const payload = encode(content);
    try { return this.#transaction(() => {
      if (this.#load(runId)) throw new RunStoreError('RUN_ALREADY_EXISTS');
      this.#database.prepare('INSERT INTO run_records (run_id, revision, payload, digest) VALUES (?, ?, ?, ?)').run(runId, 1, payload, checksum(runId, 1, payload));
      this.#history(runId, 1, payload);
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
      this.#history(runId, revision, payload);
      return { runId, revision, content: JSON.parse(payload) as JsonValue };
    }); } catch (error) { throw mapped(error); }
  }
  async commitRecords(checks: readonly { runId: string; revision: number | null }[], writes: readonly { runId: string; content: JsonValue }[]): Promise<readonly RunRecord[]> {
    if (!Array.isArray(checks) || !checks.length || checks.length > 64 || !Array.isArray(writes) || !writes.length || writes.length > checks.length
      || new Set(checks.map(c => c.runId)).size !== checks.length || new Set(writes.map(w => w.runId)).size !== writes.length) throw new RunStoreError('INVALID_RUN_RECORD');
    const expected = new Map<string, number | null>();
    for (const check of checks) {
      id(check.runId);
      if (check.revision !== null && (!Number.isSafeInteger(check.revision) || check.revision < 1 || check.revision >= Number.MAX_SAFE_INTEGER)) throw new RunStoreError('INVALID_RUN_RECORD');
      expected.set(check.runId, check.revision);
    }
    const payloads = writes.map(write => {
      if (!expected.has(write.runId)) throw new RunStoreError('INVALID_RUN_RECORD');
      return { runId: write.runId, payload: encode(write.content) };
    });
    try { return this.#transaction(() => {
      for (const [runId, revision] of expected) if ((this.#load(runId)?.revision ?? null) !== revision) throw new RunStoreError('RUN_REVISION_CONFLICT');
      return payloads.map(({ runId, payload }) => {
        const revision = (expected.get(runId) ?? 0) + 1;
        this.#database.prepare('INSERT INTO run_records (run_id, revision, payload, digest) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,digest=excluded.digest')
          .run(runId, revision, payload, checksum(runId, revision, payload));
        this.#history(runId, revision, payload);
      return { runId, revision, content: JSON.parse(payload) as JsonValue };
      });
    }); } catch (error) { throw mapped(error); }
  }
  close(): void { if (this.#closed) return; try { this.#database.close(); this.#closed = true; } catch (error) { throw mapped(error); } }
}
