import { createHash, randomUUID } from 'node:crypto';
import { isIdentifier } from '@agentflow/domain';
import type { JsonValue } from '@agentflow/domain';
import { RunStoreError } from '@agentflow/engine';
import type { EffectRecord, EffectRecordStore } from '@agentflow/engine';
import { SqliteRunRecordStore } from './sqlite-store.js';

/** Dedicated operation journal; reuses SQLite durability/CAS, never invokes an Effect. */
export class SqliteEffectRecordStore implements EffectRecordStore {
  private constructor(private readonly records: SqliteRunRecordStore, readonly identity: string) {}
  static async open(root: string): Promise<SqliteEffectRecordStore> {
    const records = await SqliteRunRecordStore.open(root);
    try {
      let metadata = await records.read('identity');
      if (!metadata) {
        try { metadata = await records.create('identity', { schema: 'agentflow-effect-store/v1', identity: randomUUID() }); }
        catch (error) { if (!(error instanceof RunStoreError) || error.code !== 'RUN_ALREADY_EXISTS') throw error; metadata = await records.read('identity'); }
      }
      const value = metadata?.content;
      if (!value || typeof value !== 'object' || Array.isArray(value) || metadata!.revision !== 1
        || Object.keys(value).sort().join(',') !== 'identity,schema' || value['schema'] !== 'agentflow-effect-store/v1'
        || typeof value['identity'] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value['identity'])) throw new RunStoreError('RUN_STORE_CORRUPT');
      return new SqliteEffectRecordStore(records, value['identity']);
    } catch (error) { records.close(); throw error; }
  }
  private id(key: string): string {
    if (!isIdentifier(key)) throw new RunStoreError('INVALID_RUN_RECORD');
    return 'operation-' + createHash('sha256').update(key).digest('hex');
  }
  async read(key: string): Promise<EffectRecord | null> {
    const row = await this.records.read(this.id(key));
    return row ? { key, revision: row.revision, content: row.content } : null;
  }
  async create(key: string, content: JsonValue): Promise<EffectRecord> {
    const row = await this.records.create(this.id(key), content);
    return { key, revision: row.revision, content: row.content };
  }
  async compareAndSwap(key: string, revision: number, content: JsonValue): Promise<EffectRecord> {
    const row = await this.records.compareAndSwap(this.id(key), revision, content);
    return { key, revision: row.revision, content: row.content };
  }
  close(): void { this.records.close(); }
}
