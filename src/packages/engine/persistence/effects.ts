import type { JsonValue } from '@agentflow/domain';

/** Separate durable logical-operation namespace, independent of any Attempt or Run row. */
export interface EffectRecord { readonly key: string; readonly revision: number; readonly content: JsonValue }
export interface EffectRecordStore {
  readonly identity: string;
  read(key: string): Promise<EffectRecord | null>;
  create(key: string, content: JsonValue): Promise<EffectRecord>;
  compareAndSwap(key: string, revision: number, content: JsonValue): Promise<EffectRecord>;
}
