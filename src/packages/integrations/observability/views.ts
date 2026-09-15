import type { JsonValue } from '@agentflow/domain';
import { archiveWorkflowViewValue, inspectWorkflowExecution, snapshotJson } from '@agentflow/engine';
import type { CompiledWorkflow, WorkflowObserver, WorkflowSnapshot, RunRecord, WorkflowDisplayDefinition } from '@agentflow/engine';
import type { SqliteRunRecordStore } from '../persistence/sqlite-store.js';

export interface RunMetadata { readonly title: string; readonly entrypoint: string; readonly scenario?: string; readonly parentRunId?: string }
export interface RunView {
  readonly runId: string; readonly revision: number; readonly snapshot: WorkflowSnapshot;
  readonly execution: WorkflowDisplayDefinition | null; readonly values: readonly JsonValue[];
  readonly attempts: readonly JsonValue[]; readonly metadata: RunMetadata | null;
  readonly missing: readonly string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Defense in depth. The source adapter still owns credential-aware redaction. */
export function redactView(value: unknown): JsonValue {
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
    if (Array.isArray(v)) return v.map(scrub);
    if (object(v)) return Object.fromEntries(Object.entries(v).filter(([key]) => !/^(?:token|admissionTokens|access_token|refresh_token|id_token|api_key|authorization|secret|privateKey)$/i.test(key)).map(([key, child]) => [key, scrub(child)]));
    return v;
  };
  return snapshotJson(scrub(value));
}
/** Pure projection: no catalog, Docker, credential store, recovery loader or file materialization. */
export function projectRun(record: RunRecord): RunView | null {
  let raw: unknown = record.content;
  if (object(raw) && raw['schema'] === 'agentflow-workflow-recovery/v1') raw = raw['checkpoint'];
  if (!object(raw) || !['agentflow-workflow-checkpoint/v5', 'agentflow-observed-run/v1'].includes(String(raw['schema'])) || !object(raw['snapshot'])) return null;
  const view = raw['snapshot'];
  if (typeof view['runId'] !== 'string' || typeof view['workflowId'] !== 'string' || !Array.isArray(view['steps'])) return null;
  return redactView({ runId: view['runId'], revision: record.revision, snapshot: view,
    execution: raw['execution'] ?? null, values: Array.isArray(raw['values']) ? raw['values'] : [],
    attempts: Array.isArray(raw['attempts']) ? raw['attempts'] : [], metadata: raw['metadata'] ?? null,
    missing: [...(!raw['execution'] ? ['未保存执行设置'] : []), ...(raw['schema'] === 'agentflow-observed-run/v1' ? ['此入口保存查看记录，不提供执行恢复'] : [])],
  }) as unknown as RunView;
}
/** Serial durable observation for legacy entrypoints using the actual compiled graph and value owners. */
export async function createWorkflowRecorder(records: SqliteRunRecordStore, compiled: CompiledWorkflow, metadata: RunMetadata): Promise<WorkflowObserver> {
  const execution = await inspectWorkflowExecution(compiled), states = new Map<string, { revision: number; values: JsonValue[]; accepted: number }>();
  return async ({ snapshot, value }) => {
    let state = states.get(snapshot.runId);
    if (!state) {
      const node = compiled.definition.start;
      const saved = await archiveWorkflowViewValue(compiled, node, compiled.definition.input.id, value, snapshot.runId);
      state = { revision: 0, values: [{ node, contract: snapshotJson(compiled.definition.input), value, saved }], accepted: 0 };
      states.set(snapshot.runId, state);
    }
    for (const step of snapshot.steps.slice(state.accepted)) {
      if (step.result.status === 'accepted') {
        const component = execution.structure.components[step.node]!;
        const contractId = component.outcomes[step.result.outcome]!;
        const saved = await archiveWorkflowViewValue(compiled, step.node, contractId, step.result.output, snapshot.runId);
        state.values.push({ node: step.node, identity: snapshotJson(step.result.identity), value: step.result.output, saved });
      }
    }
    state.accepted = snapshot.steps.length;
    const content = redactView({ schema: 'agentflow-observed-run/v1', execution, snapshot, metadata, values: state.values });
    const row = state.revision === 0 ? await records.create(snapshot.runId, content) : await records.compareAndSwap(snapshot.runId, state.revision, content);
    state.revision = row.revision;
  };
}
