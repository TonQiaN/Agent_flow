import type { JsonValue } from '@agentflow/domain';
import type { RunnerResourceSink } from './types.js';

/** Portable invocation ports; Workflow owns coordination and saved phase history. */
export type InvocationPhaseDefinition = { readonly id: string; readonly kind: 'resource'; readonly execution: JsonValue }
  | { readonly id: string; readonly kind: 'operation' };
export interface InvocationResourcePlan { readonly schema: 'agentflow-invocation-resources/v1'; readonly phases: readonly InvocationPhaseDefinition[] }
export interface InvocationPhaseHandle { readonly resource?: RunnerResourceSink; complete(): Promise<void> }
export interface InvocationPhaseSink { enter(id: string): Promise<InvocationPhaseHandle> }
