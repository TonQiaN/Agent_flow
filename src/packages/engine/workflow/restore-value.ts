import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { snapshot } from './compiler.js';
import type { WorkflowCheckpointValue } from './checkpoint.js';

export interface WorkflowValueRestoreRequest { readonly kind: 'workflow_value_restore' }
export interface WorkflowRestoredValue { readonly value: JsonValue; dispose(): Promise<void> }
export interface WorkflowValueRestoreData {
  readonly runId: string;
  readonly record: WorkflowCheckpointValue;
  readonly execution: JsonValue;
  readonly expected: { readonly identity: ExecutionIdentity; readonly componentId: string; readonly outcome: string; readonly predecessor: JsonValue } | null;
}
const requests = new WeakMap<WorkflowValueRestoreRequest, WorkflowValueRestoreData>();
/** Internal loader factory; not exported from the engine package. */
export function issueValueRestore(data: WorkflowValueRestoreData): WorkflowValueRestoreRequest {
  const request = Object.freeze({ kind: 'workflow_value_restore' as const }); requests.set(request, snapshot(data)); return request;
}
/** An installed adapter consumes a loader-issued request once. JSON copies carry no authority. */
export function consumeWorkflowValueRestore(request: WorkflowValueRestoreRequest): WorkflowValueRestoreData {
  const data = requests.get(request); if (!data) throw new DefinitionError('UNTRUSTED_WORKFLOW_VALUE_RESTORE');
  requests.delete(request); return snapshot(data);
}
/** Failed cleanup is retained and may be retried; messages never contain saved data. */
export class WorkflowRestoreError extends DefinitionError {
  constructor(code: string, readonly dispose: () => Promise<void>) { super(code); }
}
