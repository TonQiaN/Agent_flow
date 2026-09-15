import { DefinitionError } from '../errors.js';
import type { JsonValue } from '@agentflow/domain';
import type { RunRecord } from '../persistence/types.js';
import type { WorkflowCheckpoint } from './checkpoint.js';

/** Coordination facts wrap the original business checkpoint without rewriting its Attempt history. */
export interface WorkflowRecoveryRecord {
  readonly schema: 'agentflow-workflow-recovery/v1';
  readonly checkpoint: WorkflowCheckpoint;
  readonly claimRevision: number;
  readonly resourceRemoved: boolean;
}
export interface WorkflowRecoverySnapshot extends WorkflowRecoveryRecord { readonly revision: number }
export type WorkflowRecoveryProgress = Pick<WorkflowRecoveryRecord, 'claimRevision' | 'resourceRemoved'>;

/** Called after the outer storage envelope has been copied and checked. No IO or claim acquisition. */
export function unwrapWorkflowRecovery(record: RunRecord): { record: RunRecord; recovery: WorkflowRecoveryProgress | null } {
  const content = record.content;
  if (!content || typeof content !== 'object' || Array.isArray(content) || content['schema'] !== 'agentflow-workflow-recovery/v1') return { record, recovery: null };
  if (Object.keys(content).sort().join(',') !== 'checkpoint,claimRevision,resourceRemoved,schema'
    || !Number.isSafeInteger(content['claimRevision']) || (content['claimRevision'] as number) < 2
    || (content['claimRevision'] as number) > record.revision || typeof content['resourceRemoved'] !== 'boolean') throw new DefinitionError('INVALID_WORKFLOW_RECOVERY_RECORD');
  return { record: { ...record, content: content['checkpoint'] as JsonValue }, recovery: {
    claimRevision: content['claimRevision'] as number, resourceRemoved: content['resourceRemoved'] } };
}
