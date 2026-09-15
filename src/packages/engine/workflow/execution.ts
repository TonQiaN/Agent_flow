import { validateInvocationPlan } from './phases.js';
import type { InvocationResourcePlan } from './phases.js';
import type { JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson, canonicalJson as canonical } from '../json.js';
import { getPlan } from './compiler.js';
import { snapshotWorkflowStructure } from './structure.js';
import type { WorkflowStructureSnapshot } from './structure.js';
import type { CompiledWorkflow } from './types.js';
export interface WorkflowExecutionSnapshot {
  readonly version: 2;
  readonly resourcePlans: Readonly<Record<string, InvocationResourcePlan>>;
  readonly structure: WorkflowStructureSnapshot;
  readonly bindings: Readonly<Record<string, JsonValue>>;
}

/** Installed executor descriptions are evidence, never executable instructions loaded from saved JSON. */
export async function snapshotWorkflowExecution(compiled: CompiledWorkflow): Promise<WorkflowExecutionSnapshot> {
  const plan = getPlan(compiled), structure = snapshotWorkflowStructure(compiled), bindings: [string, JsonValue][] = [];
  const resourcePlans: Record<string, InvocationResourcePlan> = {};
  for (const [node, binding] of plan.bindings) {
    const describe = binding.executor.executionDefinition;
    if (!describe) throw new DefinitionError('EXECUTION_DEFINITION_UNAVAILABLE');
    const definition = copyJson(await describe(copyJson(binding.component) as unknown as typeof binding.component));
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)
      || typeof definition['schema'] !== 'string' || !definition['schema']) throw new DefinitionError('INVALID_EXECUTION_DEFINITION');
    bindings.push([node, definition]);
    const resources = await binding.executor.resourcePlan?.(copyJson(binding.component) as unknown as typeof binding.component);
    if (resources !== undefined && resources !== null) resourcePlans[node] = validateInvocationPlan(resources);
  }
  return copyJson({ version: 2, resourcePlans, structure, bindings: Object.fromEntries(bindings) }) as unknown as WorkflowExecutionSnapshot;
}
export async function assertWorkflowExecutionMatches(compiled: CompiledWorkflow, saved: unknown): Promise<void> {
  const current = await snapshotWorkflowExecution(compiled);
  let expected: JsonValue;
  try { expected = copyJson(saved); } catch { throw new DefinitionError('INVALID_WORKFLOW_EXECUTION_SNAPSHOT'); }
  if (canonical(expected) !== canonical(copyJson(current))) throw new DefinitionError('WORKFLOW_EXECUTION_MISMATCH');
}
