import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import type { WorkflowCheckpoint } from './checkpoint.js';
import type { WorkflowRecoveryHandle } from './recovery.js';
import type { CompiledWorkflow } from './types.js';

export interface WorkflowRecoveryHandoff {
  readonly compiled: CompiledWorkflow;
  readonly store: RunRecordStore;
  readonly checkpoint: WorkflowCheckpoint;
  readonly revision: number;
  dispose(): Promise<void>;
}
const handles = new WeakMap<WorkflowRecoveryHandle, () => WorkflowRecoveryHandoff>();
/** Internal factories are deliberately absent from the package exports. */
export function registerRecoveryHandoff(handle: WorkflowRecoveryHandle, take: () => WorkflowRecoveryHandoff): void { handles.set(handle, take); }
export function consumeRecoveryHandoff(handle: WorkflowRecoveryHandle): WorkflowRecoveryHandoff {
  const take = handles.get(handle); if (!take) throw new DefinitionError('UNTRUSTED_WORKFLOW_RECOVERY_HANDLE');
  const data = take(); handles.delete(handle); return data;
}
