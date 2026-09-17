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

/** A partial description is valid for viewing, never for execution recovery. */
export interface WorkflowDisplayDefinition {
  readonly structure: WorkflowStructureSnapshot;
  readonly bindings: Readonly<Record<string, JsonValue>>;
  readonly resourcePlans: Readonly<Record<string, InvocationResourcePlan>>;
  readonly unavailable: Readonly<Record<string, string>>;
}
export async function inspectWorkflowExecution(compiled: CompiledWorkflow): Promise<WorkflowDisplayDefinition> {
  const plan = getPlan(compiled), structure = snapshotWorkflowStructure(compiled);
  const bindings: Record<string, JsonValue> = {}, resourcePlans: Record<string, InvocationResourcePlan> = {}, unavailable: Record<string, string> = {};
  for (const [node, binding] of plan.bindings) {
    try {
      if (!binding.executor.executionDefinition) throw new Error('EXECUTION_DEFINITION_UNAVAILABLE');
      bindings[node] = copyJson(await binding.executor.executionDefinition(copyJson(binding.component) as unknown as typeof binding.component));
      const resources = await binding.executor.resourcePlan?.(binding.component);
      if (resources) resourcePlans[node] = validateInvocationPlan(resources);
    } catch (error) { unavailable[node] = error instanceof DefinitionError ? error.code : 'EXECUTION_DESCRIPTION_UNAVAILABLE'; }
  }
  return { structure, bindings, resourcePlans, unavailable };
}
/** Archive through the installed value owner without restoring or executing it. */
export async function archiveWorkflowViewValue(compiled: CompiledWorkflow, node: string, contractId: string, value: JsonValue, runId: string): Promise<JsonValue> {
  const binding = getPlan(compiled).bindings.get(node);
  if (!binding) throw new DefinitionError('UNKNOWN_WORKFLOW_NODE');
  const contract = [binding.input, ...binding.outcomes.values()].find(c => c.id === contractId);
  if (!contract) throw new DefinitionError('UNKNOWN_CONTRACT');
  if (contract.kind === 'json') return { schema: 'agentflow-json-value/v1', value: copyJson(value) };
  if (!binding.executor.checkpointValue) throw new DefinitionError('WORKFLOW_VALUE_PERSISTENCE_UNAVAILABLE');
  return copyJson(await binding.executor.checkpointValue(copyJson(value), runId, contractId));
}
