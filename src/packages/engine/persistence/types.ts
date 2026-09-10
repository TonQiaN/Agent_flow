import type { JsonValue } from '@agentflow/domain';

/** Storage envelope only. The engine owns versioned content, history and recovery semantics. */
export interface RunRecord {
  readonly runId: string;
  readonly revision: number;
  readonly content: JsonValue;
}
export interface RunRecordStore {
  create(runId: string, content: JsonValue): Promise<RunRecord>;
  read(runId: string): Promise<RunRecord | null>;
  compareAndSwap(runId: string, expectedRevision: number, content: JsonValue): Promise<RunRecord>;
}
/** One conditional transaction; checked records may be read guards without being written. */
export interface AtomicRunRecordStore extends RunRecordStore {
  commitRecords(checks: readonly { runId: string; revision: number | null }[], writes: readonly { runId: string; content: JsonValue }[]): Promise<readonly RunRecord[]>;
}
export class RunStoreError extends Error {
  constructor(readonly code: 'INVALID_RUN_RECORD' | 'RUN_RECORD_TOO_LARGE' | 'RUN_ALREADY_EXISTS' | 'RUN_NOT_FOUND'
    | 'RUN_REVISION_CONFLICT' | 'RUN_STORE_CLOSED' | 'RUN_STORE_UNSAFE' | 'RUN_STORE_UNSUPPORTED' | 'RUN_STORE_CORRUPT' | 'RUN_STORE_IO_ERROR') {
    super(code); this.name = 'RunStoreError';
  }
}
