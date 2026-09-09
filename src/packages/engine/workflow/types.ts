import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import type { WorkflowContractDefinition } from './structure.js';
import type { WorkflowValueRestoreRequest, WorkflowRestoredValue } from './restore-value.js';
import type { Cancellation, RunnerResourceSink } from '../runner/types.js';

export interface WorkflowContract { readonly kind: 'json' | 'files'; readonly id: string }
export type WorkflowDestination = { readonly node: string } | { readonly end: string };
export interface WorkflowRoute {
  readonly from: string;
  readonly outcome: string;
  readonly to: WorkflowDestination;
  readonly limit?: { readonly max: number; readonly exhausted: WorkflowDestination };
}
export interface WorkflowDefinition {
  readonly id: string;
  readonly start: string;
  readonly input: WorkflowContract;
  readonly outcomes: Readonly<Record<string, WorkflowContract>>;
  readonly maxSteps: number;
  readonly nodes: Readonly<Record<string, { readonly component: string }>>;
  readonly routes: readonly WorkflowRoute[];
}
export interface WorkflowIssue { readonly contractId: string; readonly path: string; readonly rule: string; readonly code: string }
export type WorkflowNodeResult = { readonly identity: ExecutionIdentity; readonly componentId: string } & (
  { readonly status: 'accepted'; readonly outcome: string; readonly output: JsonValue }
  | { readonly status: 'failed'; readonly code: string; readonly stopped: boolean; readonly issues: readonly WorkflowIssue[] });
/** Installed trusted code. A settled accepted result guarantees execution ended. */
export interface WorkflowNodeExecutor {
  validate(component: ComponentDefinition): void;
  contract(id: string): WorkflowContract;
  /** Actual registered definitions; optional for legacy executors, required for a structure snapshot. */
  contractDefinition?(id: string): WorkflowContractDefinition;
  /** Installed binding evidence, resolved before any Run executes. Missing evidence prevents persistence. */
  executionDefinition?(component: ComponentDefinition): Promise<JsonValue>;
  /** Actual backend whose resource can be saved by this invocation; absent for resource-free code. */
  resourceDefinition?(component: ComponentDefinition): Promise<JsonValue>;
  /** Save a live value through its actual owner; only trusted checkpoint coordination calls this port. */
  checkpointValue?(value: JsonValue, runId: string, contractId: string): Promise<JsonValue>;
  /** Accepts only a one-use request issued after a checkpoint has been validated. */
  restoreValue?(request: WorkflowValueRestoreRequest): Promise<WorkflowRestoredValue>;
  check(id: string, value: JsonValue): readonly WorkflowIssue[];
  execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation, persistence?: RunnerResourceSink): Promise<WorkflowNodeResult>;
}
export interface WorkflowCatalog {
  resolve(componentId: string): { readonly component: ComponentDefinition; readonly executor: WorkflowNodeExecutor };
}
export interface CompiledWorkflow { readonly definition: WorkflowDefinition }
export interface WorkflowStep { readonly node: string; readonly result: WorkflowNodeResult }
export interface WorkflowLimitEvent { readonly node: string; readonly outcome: string; readonly step: number; readonly max: number }
export interface WorkflowSnapshot {
  readonly runId: string;
  readonly workflowId: string;
  readonly status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'exhausted';
  readonly currentNode: string | null;
  readonly currentIdentity: ExecutionIdentity | null;
  readonly cancelRequested: boolean;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly issues: readonly WorkflowIssue[];
  readonly steps: readonly WorkflowStep[];
  readonly limits: readonly WorkflowLimitEvent[];
  readonly lastAccepted: WorkflowStep | null;
}
