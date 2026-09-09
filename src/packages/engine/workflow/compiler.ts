import { isIdentifier } from '@agentflow/domain';
import type { ComponentDefinition } from '@agentflow/domain';
import type { WorkflowContractDefinition } from './structure.js';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import type { CompiledWorkflow, WorkflowCatalog, WorkflowContract, WorkflowDefinition, WorkflowDestination, WorkflowNodeExecutor, WorkflowRoute } from './types.js';

export class WorkflowDefinitionError extends DefinitionError {
  constructor(code: string, readonly path: string) { super(code); }
}
export const snapshot = <T>(value: T): T => copyJson(value) as unknown as T;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: unknown, expected: string[]): boolean => object(value) && Object.keys(value).sort().join(',') === expected.sort().join(',');
const contract = (value: unknown): value is WorkflowContract => keys(value, ['kind', 'id'])
  && ['json', 'files'].includes((value as WorkflowContract).kind) && isIdentifier((value as WorkflowContract).id);
const equal = (a: WorkflowContract, b: WorkflowContract): boolean => a.kind === b.kind && a.id === b.id;
export const routeKey = (node: string, outcome: string): string => JSON.stringify([node, outcome]);
interface Binding { readonly component: ComponentDefinition; readonly executor: WorkflowNodeExecutor; readonly input: WorkflowContract; readonly outcomes: ReadonlyMap<string, WorkflowContract>; readonly definitions: readonly WorkflowContractDefinition[] | null }
interface Plan { readonly definition: WorkflowDefinition; readonly bindings: ReadonlyMap<string, Binding>; readonly routes: ReadonlyMap<string, WorkflowRoute> }
const plans = new WeakMap<CompiledWorkflow, Plan>();
/** Internal authority lookup. A JSON clone of the public definition is not an executable plan. */
export function getPlan(compiled: CompiledWorkflow): Plan {
  const plan = plans.get(compiled); if (!plan) throw new DefinitionError('UNTRUSTED_WORKFLOW_PLAN'); return plan;
}

export function compileWorkflow(value: WorkflowDefinition, catalog: WorkflowCatalog): CompiledWorkflow {
  const fail = (code: string, path: string): never => { throw new WorkflowDefinitionError(code, path); };
  let definition: WorkflowDefinition;
  try { definition = snapshot(value); } catch { return fail('INVALID_WORKFLOW', '/'); }
  if (!keys(definition, ['id', 'start', 'input', 'outcomes', 'maxSteps', 'nodes', 'routes']) || !isIdentifier(definition.id)
    || !isIdentifier(definition.start) || !contract(definition.input) || !Number.isSafeInteger(definition.maxSteps)
    || definition.maxSteps < 1 || definition.maxSteps > 10_000) return fail('INVALID_WORKFLOW', '/');
  if (!object(definition.nodes) || !Object.keys(definition.nodes).length || Object.keys(definition.nodes).length > 256) return fail('INVALID_WORKFLOW_NODES', '/nodes');
  if (!object(definition.outcomes) || !Object.keys(definition.outcomes).length || Object.keys(definition.outcomes).length > 32
    || Object.entries(definition.outcomes).some(([id, ref]) => !isIdentifier(id) || !contract(ref))) return fail('INVALID_WORKFLOW_OUTCOMES', '/outcomes');
  if (!Array.isArray(definition.routes) || definition.routes.length > 8192) return fail('INVALID_WORKFLOW_ROUTES', '/routes');
  const bindings = new Map<string, Binding>();
  for (const [id, node] of Object.entries(definition.nodes)) {
    if (!isIdentifier(id) || !keys(node, ['component']) || !isIdentifier(node.component)) return fail('INVALID_WORKFLOW_NODE', '/nodes');
    try {
      const resolved = catalog.resolve(node.component); const component = snapshot(resolved.component); const source = resolved.executor;
      if (!keys(component, ['id', 'kind', 'inputContract', 'outcomes', 'implementation']) || component.id !== node.component
        || !['agent', 'gate', 'transform', 'effect'].includes(component.kind) || !isIdentifier(component.inputContract) || !isIdentifier(component.implementation)
        || !object(component.outcomes) || !Object.keys(component.outcomes).length || Object.keys(component.outcomes).length > 32
        || Object.entries(component.outcomes).some(([outcome, ref]) => !isIdentifier(outcome) || !isIdentifier(ref))) throw new Error();
      // Capture methods once; replacing a catalog entry or executor method cannot retarget a compiled run.
      const executor: WorkflowNodeExecutor = Object.freeze({ validate: source.validate.bind(source), contract: source.contract.bind(source), check: source.check.bind(source), execute: source.execute.bind(source),
        ...(source.checkpointValue ? { checkpointValue: source.checkpointValue.bind(source) } : {}),
        ...(source.executionDefinition ? { executionDefinition: source.executionDefinition.bind(source) } : {}) });
      executor.validate(snapshot(component));
      const input = snapshot(executor.contract(component.inputContract));
      const outcomes = new Map(Object.entries(component.outcomes).map(([outcome, ref]) => [outcome, snapshot(executor.contract(ref))]));
      if (!contract(input) || input.id !== component.inputContract || [...outcomes].some(([outcome, ref]) => !contract(ref) || ref.id !== component.outcomes[outcome])) throw new Error();
      const describe = source.contractDefinition?.bind(source);
      const definitions = describe ? [...new Set([component.inputContract, ...Object.values(component.outcomes)])].map(ref => snapshot(describe(ref))) : null;
      bindings.set(id, { component, executor, input, outcomes, definitions });
    } catch { return fail('INVALID_WORKFLOW_BINDING', `/nodes/${id}`); }
  }
  const start = bindings.get(definition.start);
  if (!start) return fail('UNKNOWN_START_NODE', '/start');
  if (!equal(definition.input, start.input)) return fail('WORKFLOW_INPUT_MISMATCH', '/input');
  const routes = new Map<string, WorkflowRoute>(); const edges = new Map([...bindings.keys()].map(id => [id, new Set<string>()])); const ends = new Set<string>();
  const destination = (target: WorkflowDestination, output: WorkflowContract, source: string, path: string): void => {
    if (!object(target)) return fail('INVALID_DESTINATION', path);
    if ('node' in target && keys(target, ['node']) && isIdentifier(target.node)) {
      const next = bindings.get(target.node); if (!next) return fail('UNKNOWN_TARGET_NODE', path);
      if (!equal(output, next.input)) return fail('WORKFLOW_CONTRACT_MISMATCH', path);
      edges.get(source)!.add(target.node);
    } else if ('end' in target && keys(target, ['end']) && isIdentifier(target.end)) {
      if (!Object.hasOwn(definition.outcomes, target.end)) return fail('UNKNOWN_WORKFLOW_OUTCOME', path);
      if (!equal(output, definition.outcomes[target.end]!)) return fail('WORKFLOW_OUTPUT_MISMATCH', path);
      ends.add(target.end);
    } else return fail('INVALID_DESTINATION', path);
  };
  for (const [index, route] of definition.routes.entries()) {
    const path = `/routes/${index}`;
    if (!keys(route, ['from', 'outcome', 'to', ...(object(route) && Object.hasOwn(route, 'limit') ? ['limit'] : [])])
      || !isIdentifier(route.from) || !isIdentifier(route.outcome)) return fail('INVALID_WORKFLOW_ROUTE', path);
    const source = bindings.get(route.from); if (!source) return fail('UNKNOWN_ROUTE_SOURCE', path);
    const output = source.outcomes.get(route.outcome); if (!output) return fail('UNKNOWN_ROUTE_OUTCOME', path);
    const key = routeKey(route.from, route.outcome); if (routes.has(key)) return fail('DUPLICATE_WORKFLOW_ROUTE', path);
    destination(route.to, output, route.from, `${path}/to`);
    if (route.limit !== undefined) {
      if (!keys(route.limit, ['max', 'exhausted']) || !Number.isSafeInteger(route.limit.max) || route.limit.max < 0 || route.limit.max > 10_000) return fail('INVALID_ROUTE_LIMIT', `${path}/limit`);
      destination(route.limit.exhausted, output, route.from, `${path}/limit/exhausted`);
    }
    routes.set(key, route);
  }
  for (const [id, binding] of bindings) for (const outcome of binding.outcomes.keys()) if (!routes.has(routeKey(id, outcome))) return fail('MISSING_WORKFLOW_ROUTE', `/nodes/${id}/outcomes/${outcome}`);
  if (ends.size === 0) return fail('NO_WORKFLOW_TERMINAL', '/routes');
  if (ends.size !== Object.keys(definition.outcomes).length) return fail('UNUSED_WORKFLOW_OUTCOME', '/outcomes');
  const reachable = new Set<string>(); const queue = [definition.start];
  while (queue.length) { const id = queue.pop()!; if (reachable.has(id)) continue; reachable.add(id); queue.push(...edges.get(id)!); }
  if (reachable.size !== bindings.size) return fail('UNREACHABLE_WORKFLOW_NODE', '/nodes');
  const compiled = Object.freeze({ get definition(): WorkflowDefinition { return snapshot(definition); } });
  plans.set(compiled, { definition, bindings, routes }); return compiled;
}
