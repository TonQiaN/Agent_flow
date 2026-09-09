import { isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { canonicalJson, copyJson } from '../json.js';
import type { RunRecordStore } from '../persistence/types.js';
import { getPlan, snapshot } from './compiler.js';
import type { WorkflowCheckpoint, WorkflowCheckpointValue } from './checkpoint.js';
import { assertWorkflowExecutionMatches } from './execution.js';
import { advanceWorkflowRoute } from './route.js';
import { issueValueRestore, WorkflowRestoreError } from './restore-value.js';
import type { WorkflowValueRestoreData } from './restore-value.js';
import type { CompiledWorkflow, WorkflowIssue, WorkflowLimitEvent, WorkflowStep } from './types.js';

function valid(value: unknown): asserts value { if (!value) throw new DefinitionError('INVALID_WORKFLOW_CHECKPOINT'); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (v: unknown, fields: string[]): boolean => object(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const equal = (a: unknown, b: unknown): boolean => canonicalJson(copyJson(a)) === canonicalJson(copyJson(b));
const issues = (v: unknown): v is readonly WorkflowIssue[] => Array.isArray(v) && v.length <= 1000
  && v.every(i => shape(i, ['contractId', 'path', 'rule', 'code']) && Object.values(i).every(x => typeof x === 'string'));
const identity = (runId: string, number: number): ExecutionIdentity => ({ runId, nodeTaskId: `task-${number}`, attemptId: 'attempt-1', attemptNumber: 1 });

function validate(compiled: CompiledWorkflow, runId: string, value: unknown): { checkpoint: WorkflowCheckpoint; requests: WorkflowValueRestoreData[] } {
  let raw: JsonValue; try { raw = copyJson(value); } catch { throw new DefinitionError('INVALID_WORKFLOW_CHECKPOINT'); }
  valid(shape(raw, ['schema', 'execution', 'snapshot', 'cursor', 'values']));
  const c = raw as unknown as WorkflowCheckpoint, v = c.snapshot, cursor = c.cursor, plan = getPlan(compiled);
  valid(c.schema === 'agentflow-workflow-checkpoint/v1' && shape(v, ['runId', 'workflowId', 'status', 'currentNode', 'currentIdentity', 'cancelRequested', 'outcome', 'reason', 'issues', 'steps', 'limits', 'lastAccepted']));
  valid(v.runId === runId && v.workflowId === plan.definition.id && typeof v.cancelRequested === 'boolean'
    && ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'exhausted'].includes(v.status));
  valid(shape(cursor, ['node', 'value', 'traversals']) && object(cursor.traversals) && Array.isArray(v.steps)
    && v.steps.length <= plan.definition.maxSteps && Array.isArray(v.limits) && issues(v.issues));
  valid(Array.isArray(c.values) && c.values.length >= 1 && c.values.length <= plan.definition.maxSteps + 1);
  valid(v.reason === null || isIdentifier(v.reason));
  const requests: WorkflowValueRestoreData[] = [];
  const add = (record: WorkflowCheckpointValue, node: string, contract: { kind: string; id: string }, expected: WorkflowValueRestoreData['expected']) => {
    valid(shape(record, ['node', 'contract', 'value', 'saved']) && record.node === node && equal(record.contract, contract));
    if (contract.kind === 'json') valid(shape(record.saved, ['schema', 'value']) && object(record.saved)
      && record.saved['schema'] === 'agentflow-json-value/v1' && equal(record.saved['value'], record.value));
    else valid(object(record.saved) && typeof record.saved['schema'] === 'string' && !!record.saved['schema']);
    requests.push({ runId, record, expected, execution: null });
  };
  add(c.values[0]!, plan.definition.start, plan.definition.input, null);
  let node: string | null = plan.definition.start, current = c.values[0]!.value, valueIndex = 1;
  let lastAccepted: WorkflowStep | null = null, failed: WorkflowStep | null = null;
  let terminal: { outcome: string; exhausted: boolean } | null = null;
  const traversals = new Map<string, number>(), limits: WorkflowLimitEvent[] = [];
  let beforeLast: { traversals: Record<string, number>; limits: WorkflowLimitEvent[] } | null = null;
  for (const [index, step] of v.steps.entries()) {
    valid(shape(step, ['node', 'result']) && node !== null && step.node === node);
    const binding = plan.bindings.get(node)!, r = step.result;
    valid(object(r) && r.componentId === binding.component.id && equal(r.identity, identity(runId, index + 1)));
    if (r.status === 'failed') {
      valid(index === v.steps.length - 1 && shape(r, ['identity', 'componentId', 'status', 'code', 'stopped', 'issues'])
        && isIdentifier(r.code) && typeof r.stopped === 'boolean' && issues(r.issues));
      failed = step; continue;
    }
    valid(r.status === 'accepted' && shape(r, ['identity', 'componentId', 'status', 'outcome', 'output']) && isIdentifier(r.outcome) && binding.outcomes.has(r.outcome));
    const record = c.values[valueIndex++]; valid(record && equal(record.value, r.output));
    add(record, node, binding.outcomes.get(r.outcome)!, { identity: identity(runId, index + 1), componentId: binding.component.id, outcome: r.outcome, predecessor: current });
    current = r.output; lastAccepted = step;
    beforeLast = { traversals: Object.fromEntries(traversals), limits: snapshot(limits) };
    const transition = advanceWorkflowRoute(compiled, node, r.outcome, index + 1, traversals);
    if (transition.event) limits.push(transition.event);
    if ('end' in transition.destination) { terminal = { outcome: transition.destination.end, exhausted: transition.exhausted }; node = null; }
    else node = transition.destination.node;
  }
  valid(valueIndex === c.values.length && equal(v.lastAccepted, lastAccepted) && equal(cursor.value, current));
  const counters = (counts: Record<string, number>, events: readonly WorkflowLimitEvent[]) => equal(cursor.traversals, counts) && equal(v.limits, events);
  const routed = counters(Object.fromEntries(traversals), limits);
  if (v.status === 'cancelled') {
    valid(v.cancelRequested && v.reason === 'CANCEL_REQUESTED' && v.outcome === null && v.issues.length === 0
      && cursor.node === null && v.currentNode === null && v.currentIdentity === null);
    valid((!terminal && routed) || (!failed && beforeLast && counters(beforeLast.traversals, beforeLast.limits)));
    if (failed) valid(failed.result.status === 'failed' && failed.result.stopped);
  } else {
    valid(routed);
    if (v.status === 'succeeded' || v.status === 'exhausted') {
      valid(!failed && !v.cancelRequested && cursor.node === null && v.currentNode === null && v.currentIdentity === null && v.issues.length === 0);
      if (v.status === 'succeeded') valid(terminal && !terminal.exhausted && v.outcome === terminal.outcome && v.reason === null);
      else if (v.reason === 'ROUTE_LIMIT_EXCEEDED') valid(terminal?.exhausted && v.outcome === terminal.outcome);
      else valid(v.reason === 'MAX_STEPS_EXCEEDED' && !terminal && v.steps.length === plan.definition.maxSteps && v.outcome === null);
    } else {
      valid(!terminal && node !== null && cursor.node === node && v.currentNode === node && v.outcome === null);
      if (v.status === 'failed') {
        valid(v.reason !== null && equal(v.currentIdentity, identity(runId, failed ? v.steps.length : v.steps.length + 1)));
        if (failed && failed.result.status === 'failed') valid(v.reason === (failed.result.stopped ? failed.result.code : 'EXECUTION_STOP_UNCONFIRMED') && equal(v.issues, failed.result.issues) && (!failed.result.stopped || !v.cancelRequested));
        if (!failed) valid(v.steps.length < plan.definition.maxSteps);
      } else {
        valid(!failed && v.reason === null && v.issues.length === 0 && v.cancelRequested === (v.status === 'cancelling'));
        valid(v.currentIdentity === null || v.steps.length < plan.definition.maxSteps && equal(v.currentIdentity, identity(runId, v.steps.length + 1)));
        if (v.status === 'queued') valid(v.steps.length === 0 && v.currentIdentity === null);
      }
    }
  }
  return { checkpoint: c, requests };
}

export interface LoadedWorkflowCheckpoint {
  readonly revision: number;
  readonly checkpoint: WorkflowCheckpoint;
  dispose(): Promise<void>;
}
/** Loads facts and independent files. Never calls execute, writes Run state, or queries/stops a container. */
export async function loadWorkflowCheckpoint(compiled: CompiledWorkflow, runId: string, store: Pick<RunRecordStore, 'read'>): Promise<LoadedWorkflowCheckpoint> {
  if (!isIdentifier(runId)) throw new DefinitionError('INVALID_RUN_ID');
  const result = await store.read(runId); if (!result) throw new DefinitionError('RUN_NOT_FOUND');
  let record: typeof result;
  try { record = snapshot(result); } catch { throw new DefinitionError('INVALID_WORKFLOW_CHECKPOINT'); }
  valid(shape(record, ['runId', 'revision', 'content']) && record.runId === runId && Number.isSafeInteger(record.revision) && record.revision >= 1);
  let validated: ReturnType<typeof validate>;
  try { validated = validate(compiled, runId, record.content); } catch { throw new DefinitionError('INVALID_WORKFLOW_CHECKPOINT'); }
  const { checkpoint, requests } = validated;
  await assertWorkflowExecutionMatches(compiled, checkpoint.execution);
  const disposers: (() => Promise<void>)[] = []; let closing: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => { while (disposers.length) { await disposers.at(-1)!(); disposers.pop(); } })().finally(() => { closing = null; });
    return closing;
  };
  try {
    // Check all required capabilities before materializing any value.
    for (const r of requests) if (r.record.contract.kind === 'files' && !getPlan(compiled).bindings.get(r.record.node)!.executor.restoreValue) throw new DefinitionError('WORKFLOW_VALUE_RESTORE_UNAVAILABLE');
    for (const r of requests) {
      const binding = getPlan(compiled).bindings.get(r.record.node)!;
      if (r.record.contract.kind === 'files') {
        const handle = await binding.executor.restoreValue!(issueValueRestore({ ...r, execution: checkpoint.execution.bindings[r.record.node]! }));
        if (!handle || typeof handle.dispose !== 'function') throw new DefinitionError('INVALID_WORKFLOW_RESTORE_HANDLE');
        disposers.push(handle.dispose.bind(handle));
        if (!equal(handle.value, r.record.value)) throw new DefinitionError('WORKFLOW_RESTORED_VALUE_MISMATCH');
      }
      // Only accepted values need acceptance validation; invalid original input may explain a failed Run.
      if (r.expected !== null) for (const [id, value] of [[binding.component.inputContract, r.expected.predecessor], [r.record.contract.id, r.record.value]] as const) {
        const checked = snapshot(binding.executor.check(id, snapshot(value)));
        if (!issues(checked) || checked.length) throw new DefinitionError('WORKFLOW_RESTORED_CONTRACT_MISMATCH');
      }
    }
    return Object.freeze({ revision: record.revision, get checkpoint() { return snapshot(checkpoint); }, dispose });
  } catch (error) {
    if (error instanceof WorkflowRestoreError) disposers.push(error.dispose);
    try { await dispose(); } catch { throw new WorkflowRestoreError('WORKFLOW_RESTORE_CLEANUP_FAILED', dispose); }
    throw new DefinitionError(error instanceof DefinitionError ? error.code : 'WORKFLOW_VALUE_RESTORE_FAILED');
  }
}
