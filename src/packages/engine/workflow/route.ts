import { getPlan, routeKey } from './compiler.js';
import type { CompiledWorkflow, WorkflowDestination, WorkflowLimitEvent } from './types.js';

/** Shared by execution and checkpoint consistency checks; never executes a node. */
export function advanceWorkflowRoute(compiled: CompiledWorkflow, node: string, outcome: string, step: number,
  traversals: Map<string, number>): { destination: WorkflowDestination; exhausted: boolean; event: WorkflowLimitEvent | null } {
  const key = routeKey(node, outcome), route = getPlan(compiled).routes.get(key)!, count = traversals.get(key) ?? 0;
  const exhausted = route.limit !== undefined && count >= route.limit.max;
  if (!exhausted) traversals.set(key, count + 1);
  return { destination: exhausted ? route.limit!.exhausted : route.to, exhausted,
    event: exhausted ? { node, outcome, step, max: route.limit!.max } : null };
}
