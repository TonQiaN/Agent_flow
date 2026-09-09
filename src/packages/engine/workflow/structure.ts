import { isIdentifier } from '@agentflow/domain';
import type { ComponentDefinition, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { ContractRegistry } from '../contracts/registry.js';
import { FileContractRegistry } from '../contracts/files.js';
import type { FileContract } from '../contracts/files.js';
import { copyJson } from '../json.js';
import { getPlan } from './compiler.js';
import type { CompiledWorkflow, WorkflowDefinition } from './types.js';

/** Supplied by an installed executor from the registries it actually uses. */
export type WorkflowContractDefinition = { readonly kind: 'json'; readonly id: string; readonly schema: JsonValue }
  | { readonly kind: 'files'; readonly id: string; readonly definition: FileContract; readonly jsonContracts: Readonly<Record<string, JsonValue>> };
export type WorkflowStoredContract = Exclude<WorkflowContractDefinition, { kind: 'files' }>
  | { readonly kind: 'files'; readonly id: string; readonly definition: FileContract };
/** Structural evidence only. Does not describe executable code, environment, model, auth or a Run. */
export interface WorkflowStructureSnapshot {
  readonly version: 1;
  readonly workflow: WorkflowDefinition;
  readonly components: Readonly<Record<string, ComponentDefinition>>;
  readonly contracts: readonly WorkflowStoredContract[];
}
const canonical = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]): boolean => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
function fail(code = 'INVALID_WORKFLOW_CONTRACT_DEFINITION'): never { throw new DefinitionError(code); }

export function snapshotWorkflowStructure(compiled: CompiledWorkflow): WorkflowStructureSnapshot {
  const plan = getPlan(compiled), contracts = new Map<string, WorkflowStoredContract>();
  const add = (value: WorkflowStoredContract): void => {
    const key = JSON.stringify([value.kind, value.id]), prior = contracts.get(key);
    if (prior && canonical(copyJson(prior)) !== canonical(copyJson(value))) fail('WORKFLOW_CONTRACT_DEFINITION_MISMATCH');
    contracts.set(key, value);
  };
  for (const binding of plan.bindings.values()) {
    if (!binding.definitions) fail('WORKFLOW_CONTRACT_DEFINITION_UNAVAILABLE');
    const refs = new Map([binding.input, ...binding.outcomes.values()].map(ref => [ref.id, ref]));
    for (const raw of binding.definitions) {
      const d: unknown = copyJson(raw);
      if (!object(d) || !isIdentifier(d.id) || !refs.has(d.id) || d.kind !== refs.get(d.id)!.kind) fail();
      try {
        if (d.kind === 'json') {
          if (!keys(d, ['kind', 'id', 'schema'])) fail();
          const registry = new ContractRegistry(); registry.register(d.id, d.schema);
          add({ kind: 'json', id: d.id, schema: registry.definition(d.id) });
        } else {
          if (!keys(d, ['kind', 'id', 'definition', 'jsonContracts']) || !object(d.jsonContracts)) fail();
          const json = new ContractRegistry();
          for (const [id, schema] of Object.entries(d.jsonContracts)) json.register(id, schema);
          const files = new FileContractRegistry(json); files.register(d.id, d.definition);
          const definition = files.definition(d.id);
          const used = new Set(definition.rules.flatMap(rule => rule.jsonContract === undefined ? [] : [rule.jsonContract]));
          if (used.size !== Object.keys(d.jsonContracts).length || [...used].some(id => !Object.hasOwn(d.jsonContracts as object, id))) fail();
          for (const id of [...used].sort()) add({ kind: 'json', id, schema: json.definition(id) });
          add({ kind: 'files', id: d.id, definition });
        }
      } catch (error) {
        if (error instanceof DefinitionError && error.code === 'WORKFLOW_CONTRACT_DEFINITION_MISMATCH') throw error;
        fail();
      }
      refs.delete(d.id);
    }
    if (refs.size) fail();
  }
  const result: WorkflowStructureSnapshot = { version: 1, workflow: plan.definition,
    components: Object.fromEntries([...plan.bindings].map(([node, binding]) => [node, binding.component])),
    contracts: [...contracts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, definition]) => definition) };
  return copyJson(result) as unknown as WorkflowStructureSnapshot;
}

/** A matching structure is necessary but insufficient for resuming executable work. */
export function assertWorkflowStructureMatches(compiled: CompiledWorkflow, saved: unknown): void {
  const current = snapshotWorkflowStructure(compiled);
  let encoded: string;
  try { encoded = canonical(copyJson(saved)); } catch { throw new DefinitionError('INVALID_WORKFLOW_STRUCTURE_SNAPSHOT'); }
  if (encoded !== canonical(copyJson(current))) throw new DefinitionError('WORKFLOW_STRUCTURE_MISMATCH');
}
