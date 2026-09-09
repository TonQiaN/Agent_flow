import type { JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import { getPlan, snapshot } from './compiler.js';
import { snapshotWorkflowExecution } from './execution.js';
import type { WorkflowExecutionSnapshot } from './execution.js';
import type { CompiledWorkflow, WorkflowContract, WorkflowSnapshot } from './types.js';

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
  readonly schema: 'agentflow-workflow-checkpoint/v1';
  readonly execution: WorkflowExecutionSnapshot;
  readonly snapshot: WorkflowSnapshot;
  readonly cursor: WorkflowCursor;
  readonly values: readonly WorkflowCheckpointValue[];
}

/** One writer per live Run; failed writes poison the lane rather than skipping a revision. */
export class CheckpointWriter {
  #revision: number | undefined;
  #tail: Promise<void> = Promise.resolve();
  readonly #values: WorkflowCheckpointValue[] = [];
  private constructor(private readonly compiled: CompiledWorkflow, private readonly runId: string,
    private readonly store: RunRecordStore, private readonly execution: WorkflowExecutionSnapshot) {}
  static async prepare(compiled: CompiledWorkflow, runId: string, store: RunRecordStore): Promise<CheckpointWriter> {
    for (const binding of getPlan(compiled).bindings.values()) {
      if ([binding.input, ...binding.outcomes.values()].some(c => c.kind === 'files') && !binding.executor.checkpointValue) throw new DefinitionError('WORKFLOW_VALUE_PERSISTENCE_UNAVAILABLE');
    }
    return new CheckpointWriter(compiled, runId, store, await snapshotWorkflowExecution(compiled));
  }
  async saveValue(node: string, contract: WorkflowContract, value: JsonValue): Promise<WorkflowCheckpointValue> {
    const binding = getPlan(this.compiled).bindings.get(node)!;
    const saved = contract.kind === 'json' ? { schema: 'agentflow-json-value/v1', value: snapshot(value) }
      : await binding.executor.checkpointValue!(snapshot(value), this.runId, contract.id);
    const copied = snapshot(saved);
    if (copied === null || typeof copied !== 'object' || Array.isArray(copied) || typeof copied['schema'] !== 'string' || !copied['schema']) throw new DefinitionError('INVALID_WORKFLOW_VALUE_SNAPSHOT');
    return snapshot({ node, contract, value, saved: copied });
  }
  /** Publish with the corresponding input/accepted step, without an intervening await. */
  acceptValue(value: WorkflowCheckpointValue): void { this.#values.push(snapshot(value)); }
  write(view: WorkflowSnapshot, cursor: WorkflowCursor): Promise<void> {
    const content = snapshot({ schema: 'agentflow-workflow-checkpoint/v1', execution: this.execution,
      snapshot: view, cursor, values: this.#values }) as unknown as JsonValue;
    this.#tail = this.#tail.then(async () => {
      const record = this.#revision === undefined ? await this.store.create(this.runId, content)
        : await this.store.compareAndSwap(this.runId, this.#revision, content);
      this.#revision = record.revision;
    });
    return this.#tail;
  }
}
