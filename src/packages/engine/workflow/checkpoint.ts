import type { RetryDecision } from '../retry/policy.js';
import { createPhaseSink, invocationPlanFor } from './phases.js';
import type { InvocationPhaseCheckpoint } from './phases.js';
import type { JsonValue, ExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import { canonicalJson, copyJson } from '../json.js';
import { validateRunnerResourceCheckpoint } from '../runner/checkpoint.js';
import type { RunnerResourceCheckpoint, RunnerResourceSink, RunnerLaunchState } from '../runner/types.js';
import { runnerLaunchStates } from '../runner/launch.js';
import { getPlan, snapshot } from './compiler.js';
import { snapshotWorkflowExecution } from './execution.js';
import type { WorkflowExecutionSnapshot } from './execution.js';
import type { CompiledWorkflow, WorkflowContract, WorkflowSnapshot, WorkflowNodeResult } from './types.js';

/** A token in snapshot/cursor is usable after restart only with its corresponding saved value. */
export interface WorkflowCheckpointValue {
  readonly node: string;
  readonly contract: WorkflowContract;
  readonly value: JsonValue;
  readonly saved: JsonValue;
}
export interface WorkflowCursor {
  readonly node: string | null;
  readonly value: JsonValue;
  readonly traversals: Readonly<Record<string, number>>;
}
/** Inspectable durable facts, not an executable plan or permission to resume a Run. */
export interface WorkflowCheckpoint {
  readonly schema: 'agentflow-workflow-checkpoint/v5';
  readonly execution: WorkflowExecutionSnapshot;
  readonly snapshot: WorkflowSnapshot;
  readonly cursor: WorkflowCursor;
  readonly values: readonly WorkflowCheckpointValue[];
  readonly attempts: readonly WorkflowAttemptCheckpoint[];
}
export interface WorkflowAttemptCheckpoint {
  readonly node: string;
  readonly identity: ExecutionIdentity;
  readonly resultStep: number | null;
  readonly resource: RunnerResourceCheckpoint | null;
  readonly launch: RunnerLaunchState | null;
  readonly interrupted: boolean;
  readonly retry?: RetryDecision & { readonly result: Extract<WorkflowNodeResult, {status:'failed'}> };
  readonly phases?: readonly InvocationPhaseCheckpoint[];
}

/** One writer per live Run; failed writes poison the lane rather than skipping a revision. */
export class CheckpointWriter {
  #revision: number | undefined;
  #tail: Promise<void> = Promise.resolve();
  readonly #values: WorkflowCheckpointValue[] = [];
  readonly #attempts: { -readonly [K in keyof WorkflowAttemptCheckpoint]: WorkflowAttemptCheckpoint[K] }[] = [];
  readonly #resourceDefinitions = new Map<string, JsonValue>();
  private constructor(private readonly compiled: CompiledWorkflow, private readonly runId: string,
    private readonly store: RunRecordStore, private readonly execution: WorkflowExecutionSnapshot) {}
  static async prepare(compiled: CompiledWorkflow, runId: string, store: RunRecordStore): Promise<CheckpointWriter> {
    for (const binding of getPlan(compiled).bindings.values()) {
      if (binding.executor.checkpointAcceptance && !binding.executor.restoreValue) throw new DefinitionError('WORKFLOW_VALUE_RESTORE_UNAVAILABLE');
      if ([binding.input, ...binding.outcomes.values()].some(c => c.kind === 'files') && !binding.executor.checkpointValue) throw new DefinitionError('WORKFLOW_VALUE_PERSISTENCE_UNAVAILABLE');
    }
    const writer = new CheckpointWriter(compiled, runId, store, await snapshotWorkflowExecution(compiled));
    for (const [node, binding] of getPlan(compiled).bindings) if (!invocationPlanFor(writer.execution.resourcePlans, node) && binding.executor.resourceDefinition)
      writer.#resourceDefinitions.set(node, snapshot(await binding.executor.resourceDefinition(snapshot(binding.component))));
    return writer;
  }
  static async resume(compiled: CompiledWorkflow, checkpoint: WorkflowCheckpoint, store: RunRecordStore, revision: number): Promise<CheckpointWriter> {
    const writer = await CheckpointWriter.prepare(compiled, checkpoint.snapshot.runId, store);
    if (canonicalJson(copyJson(writer.execution)) !== canonicalJson(copyJson(checkpoint.execution))) throw new DefinitionError('WORKFLOW_EXECUTION_MISMATCH');
    writer.#revision = revision;
    writer.#values.push(...snapshot(checkpoint.values)); writer.#attempts.push(...snapshot(checkpoint.attempts));
    const last = writer.#attempts.at(-1); if (last?.resultStep === null && !last.retry) last.interrupted = true;
    return writer;
  }
  beginAttempt(node: string, identity: ExecutionIdentity): void {
    this.#attempts.push({ node, identity: snapshot(identity), resultStep: null, resource: null, launch: null, interrupted: false, ...(invocationPlanFor(this.execution.resourcePlans, node) ? { phases: [] } : {}) });
  }
  retryAttempt(result: Extract<WorkflowNodeResult,{status:'failed'}>, decision: RetryDecision): void { this.#attempts.at(-1)!.retry = snapshot({...decision,result}); }
  finishAttempt(resultStep: number): void { this.#attempts.at(-1)!.resultStep = resultStep; }
  resourceSink(node: string, identity: ExecutionIdentity, commit: () => Promise<void>): { sink: RunnerResourceSink; close(): void } | undefined {
    const definition = this.#resourceDefinitions.get(node); if (definition === undefined) return undefined;
    const attempt = this.#attempts.at(-1)!; let closed = false, writing = false;
    const active = () => {
      if (closed || writing || attempt !== this.#attempts.at(-1) || attempt.resultStep !== null) throw new DefinitionError('WORKFLOW_RESOURCE_PORT_CLOSED');
    };
    const persist = async () => {
      writing = true;
      try { await commit(); } catch (error) { closed = true; throw error; } finally { writing = false; }
    };
    return { close: () => { closed = true; }, sink: Object.freeze({ save: async (value: RunnerResourceCheckpoint) => {
      active(); if (attempt.resource !== null) throw new DefinitionError('WORKFLOW_RESOURCE_PORT_CLOSED');
      const record = validateRunnerResourceCheckpoint(value);
      if (attempt.node !== node || canonicalJson(copyJson(record.identity)) !== canonicalJson(copyJson(identity))
        || canonicalJson(record.execution) !== canonicalJson(definition)
        || this.#attempts.some(a => a.resource?.resource.id === record.resource.id || a.phases?.some(p => p.resource?.resource.id === record.resource.id))) throw new DefinitionError('WORKFLOW_RESOURCE_MISMATCH');
      attempt.resource = record; attempt.launch = 'allocated';
      await persist();
    }, launch: async (state: Exclude<RunnerLaunchState, 'allocated'>) => {
      active();
      if (!attempt.resource || attempt.launch === null || !runnerLaunchStates.includes(state)
        || state !== runnerLaunchStates[runnerLaunchStates.indexOf(attempt.launch) + 1]) throw new DefinitionError('WORKFLOW_LAUNCH_TRANSITION_INVALID');
      attempt.launch = state; await persist();
    } }) };
  }
  phaseSink(node: string, identity: ExecutionIdentity, commit: () => Promise<void>) {
    const plan = invocationPlanFor(this.execution.resourcePlans, node); if (!plan) return undefined;
    const attempt = this.#attempts.at(-1)!;
    return createPhaseSink(plan, attempt.phases as InvocationPhaseCheckpoint[], identity,
      () => attempt === this.#attempts.at(-1) && attempt.resultStep === null,
      id => !this.#attempts.some(a => a.resource?.resource.id === id || a.phases?.some(p => p.resource?.resource.id === id)), commit);
  }
  phasesComplete(node: string): boolean {
    const plan = invocationPlanFor(this.execution.resourcePlans, node), phases = this.#attempts.at(-1)?.phases;
    return !plan || phases?.length === plan.phases.length && phases.every(p => p.status === 'completed');
  }
  async saveValue(node: string, contract: WorkflowContract, value: JsonValue, accepted?: Extract<WorkflowNodeResult, { status: 'accepted' }>): Promise<WorkflowCheckpointValue> {
    const binding = getPlan(this.compiled).bindings.get(node)!;
    const saved = contract.kind === 'json' ? accepted && binding.executor.checkpointAcceptance
      ? { schema: 'agentflow-json-value/v2', value: snapshot(value), provenance: snapshot(await binding.executor.checkpointAcceptance(snapshot(accepted))) }
      : { schema: 'agentflow-json-value/v1', value: snapshot(value) }
      : await binding.executor.checkpointValue!(snapshot(value), this.runId, contract.id);
    if (contract.kind === 'json' && accepted && binding.executor.checkpointAcceptance) {
      const provenance = (saved as { provenance?: JsonValue }).provenance;
      if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || typeof provenance['schema'] !== 'string' || !provenance['schema']) throw new DefinitionError('INVALID_WORKFLOW_VALUE_SNAPSHOT');
    }
    const copied = snapshot(saved);
    if (copied === null || typeof copied !== 'object' || Array.isArray(copied) || typeof copied['schema'] !== 'string' || !copied['schema']) throw new DefinitionError('INVALID_WORKFLOW_VALUE_SNAPSHOT');
    return snapshot({ node, contract, value, saved: copied });
  }
  /** Publish with the corresponding input/accepted step, without an intervening await. */
  acceptValue(value: WorkflowCheckpointValue): void { this.#values.push(snapshot(value)); }
  write(view: WorkflowSnapshot, cursor: WorkflowCursor): Promise<void> {
    const content = snapshot({ schema: 'agentflow-workflow-checkpoint/v5', execution: this.execution,
      snapshot: view, cursor, values: this.#values, attempts: this.#attempts }) as unknown as JsonValue;
    this.#tail = this.#tail.then(async () => {
      const record = this.#revision === undefined ? await this.store.create(this.runId, content)
        : await this.store.compareAndSwap(this.runId, this.#revision, content);
      this.#revision = record.revision;
    });
    return this.#tail;
  }
}
