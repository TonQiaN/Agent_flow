import { isIdentifier } from '@agentflow/domain';
import type { JsonValue, ExecutionIdentity } from '@agentflow/domain';
import type { RunnerResourceCheckpoint, RunnerResourceSink, RunnerLaunchState } from '../runner/types.js';
import { validateRunnerResourceCheckpoint } from '../runner/checkpoint.js';
import { runnerLaunchStates } from '../runner/launch.js';
import { DefinitionError } from '../errors.js';
import { copyJson, canonicalJson } from '../json.js';
export type InvocationPhaseDefinition = { readonly id: string; readonly kind: 'resource'; readonly execution: JsonValue }
  | { readonly id: string; readonly kind: 'operation' };
export interface InvocationResourcePlan { readonly schema: 'agentflow-invocation-resources/v1'; readonly phases: readonly InvocationPhaseDefinition[] }
export interface InvocationPhaseCheckpoint {
  readonly id: string; readonly kind: 'resource' | 'operation'; readonly status: 'active' | 'completed';
  readonly resource: RunnerResourceCheckpoint | null; readonly launch: RunnerLaunchState | null;
}
export interface InvocationPhaseHandle { readonly resource?: RunnerResourceSink; complete(): Promise<void> }
export interface InvocationPhaseSink { enter(id: string): Promise<InvocationPhaseHandle> }
const equal = (a: unknown, b: unknown) => canonicalJson(copyJson(a)) === canonicalJson(copyJson(b));
const check = (value: unknown) => { if (!value) throw new DefinitionError('INVALID_INVOCATION_PHASES'); };
export function validateInvocationPlan(value: unknown): InvocationResourcePlan {
  const plan = copyJson(value) as unknown as InvocationResourcePlan;
  check(plan && Object.keys(plan).sort().join(',') === 'phases,schema' && plan.schema === 'agentflow-invocation-resources/v1'
    && Array.isArray(plan.phases) && plan.phases.length > 0 && plan.phases.length <= 8);
  const ids = new Set<string>();
  for (const p of plan.phases) {
    check(p && isIdentifier(p.id) && !ids.has(p.id)); ids.add(p.id);
    check(p.kind === 'operation' ? Object.keys(p).sort().join(',') === 'id,kind'
      : p.kind === 'resource' && Object.keys(p).sort().join(',') === 'execution,id,kind' && p.execution !== null && typeof p.execution === 'object' && !Array.isArray(p.execution));
  }
  return plan;
}
export function phaseUnconfirmed(phases: readonly InvocationPhaseCheckpoint[] = []): boolean {
  return phases.some(p => p.kind === 'operation' && p.status === 'active' || p.launch?.endsWith('_pending'));
}
export function validatePhaseHistory(phases: readonly InvocationPhaseCheckpoint[], identity: ExecutionIdentity, resources: Set<string>): void {
  check(Array.isArray(phases) && phases.length <= 8); const ids = new Set<string>();
  for (const [index, p] of phases.entries()) {
    check(p && Object.keys(p).sort().join(',') === 'id,kind,launch,resource,status' && isIdentifier(p.id) && !ids.has(p.id)
      && ['resource', 'operation'].includes(p.kind) && ['active', 'completed'].includes(p.status)
      && (p.status === 'completed' || index === phases.length - 1)); ids.add(p.id);
    if (p.resource !== null) {
      const r = validateRunnerResourceCheckpoint(p.resource);
      check(p.kind === 'resource' && equal(r.identity, identity) && !resources.has(r.resource.id)); resources.add(r.resource.id);
      check(p.launch !== null && runnerLaunchStates.includes(p.launch));
    } else check(p.launch === null);
    check(p.kind !== 'resource' || p.status !== 'completed' || p.resource !== null);
    check(p.status !== 'completed' || !p.launch?.endsWith('_pending'));
  }
}
export function assertPhasePlan(phases: readonly InvocationPhaseCheckpoint[], plan: InvocationResourcePlan): void {
  check(phases.length <= plan.phases.length);
  for (const [index, p] of phases.entries()) {
    const expected = plan.phases[index]!;
    check(p.id === expected.id && p.kind === expected.kind);
    if (p.resource) check(expected.kind === 'resource' && equal(p.resource.execution, expected.execution));
  }
}
type MutablePhase = { -readonly [K in keyof InvocationPhaseCheckpoint]: InvocationPhaseCheckpoint[K] };
export function createPhaseSink(plan: InvocationResourcePlan, phases: MutablePhase[], identity: ExecutionIdentity,
  current: () => boolean, unique: (id: string) => boolean, commit: () => Promise<void>) {
  let closed = false, writing = false;
  const active = () => { if (closed || writing || !current()) throw new DefinitionError('WORKFLOW_RESOURCE_PORT_CLOSED'); };
  const persist = async () => { writing = true; try { await commit(); } catch (e) { closed = true; throw e; } finally { writing = false; } };
  const sink: InvocationPhaseSink = Object.freeze({ enter: async (id: string) => {
    active(); const definition = plan.phases[phases.length];
    if (!definition || definition.id !== id || phases.at(-1)?.status === 'active') throw new DefinitionError('WORKFLOW_PHASE_TRANSITION_INVALID');
    const p: MutablePhase = { id, kind: definition.kind, status: 'active', resource: null, launch: null }; phases.push(p); await persist();
    const owns = () => { active(); if (p !== phases.at(-1) || p.status !== 'active') throw new DefinitionError('WORKFLOW_RESOURCE_PORT_CLOSED'); };
    const resource: RunnerResourceSink = Object.freeze({ save: async (value: RunnerResourceCheckpoint) => {
      owns(); const r = validateRunnerResourceCheckpoint(value);
      if (definition.kind !== 'resource' || p.resource || !equal(r.identity, identity) || !equal(r.execution, definition.execution) || !unique(r.resource.id)) throw new DefinitionError('WORKFLOW_RESOURCE_MISMATCH');
      p.resource = r; p.launch = 'allocated'; await persist();
    }, launch: async (state: Exclude<RunnerLaunchState, 'allocated'>) => {
      owns(); if (!p.resource || p.launch === null || !runnerLaunchStates.includes(state) || state !== runnerLaunchStates[runnerLaunchStates.indexOf(p.launch) + 1]) throw new DefinitionError('WORKFLOW_LAUNCH_TRANSITION_INVALID');
      p.launch = state; await persist();
    } });
    return Object.freeze({ ...(definition.kind === 'resource' ? { resource } : {}), complete: async () => {
      owns(); if (definition.kind === 'resource' && (!p.resource || p.launch?.endsWith('_pending'))) throw new DefinitionError('WORKFLOW_PHASE_UNCONFIRMED');
      p.status = 'completed'; await persist();
    } });
  } });
  return { sink, close: () => { closed = true; } };
}

export function invocationPlanFor(plans: Readonly<Record<string, InvocationResourcePlan>>, node: string): InvocationResourcePlan | undefined {
  return Object.hasOwn(plans, node) ? plans[node] : undefined;
}
