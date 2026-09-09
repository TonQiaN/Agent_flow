import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import { advanceWorkflowRoute } from './route.js';
import { CheckpointWriter, type WorkflowCheckpointValue } from './checkpoint.js';
import { getPlan, snapshot } from './compiler.js';
import type { CompiledWorkflow, WorkflowIssue, WorkflowNodeResult, WorkflowSnapshot, WorkflowStep, WorkflowLimitEvent } from './types.js';

type MutableRun = { -readonly [K in keyof WorkflowSnapshot]: WorkflowSnapshot[K] };
interface Run {
  view: MutableRun; steps: WorkflowStep[]; limits: WorkflowLimitEvent[];
  node: string | null; value: JsonValue; traversals: Map<string, number>;
  persistent: boolean; ready: boolean; writer: CheckpointWriter | null;
}
export interface WorkflowRunHandle { readonly completion: Promise<WorkflowSnapshot>; query(): WorkflowSnapshot; cancel(): boolean }
export interface WorkflowPersistentRunHandle { readonly completion: Promise<WorkflowSnapshot>; query(): WorkflowSnapshot; cancel(): Promise<boolean> }
const finished = (run: Run): boolean => ['succeeded', 'failed', 'cancelled', 'exhausted'].includes(run.view.status);
const same = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;
const issuesValid = (issues: readonly WorkflowIssue[]): boolean => Array.isArray(issues) && issues.length <= 1000 && issues.every(issue => !!issue
  && typeof issue === 'object' && Object.keys(issue).sort().join(',') === 'code,contractId,path,rule'
  && Object.values(issue).every(value => typeof value === 'string'));

/** One serial execution path. Optional checkpoints persist facts without introducing another scheduler. */
export class WorkflowRuntime {
  readonly #runs = new Map<string, Run>();
  query(runId: string): WorkflowSnapshot { return snapshot(this.#require(runId).view); }
  cancel(runId: string): boolean {
    const run = this.#require(runId);
    if (run.persistent) throw new DefinitionError('USE_PERSISTENT_CANCELLATION');
    if (finished(run)) return false;
    run.view.cancelRequested = true; run.view.status = 'cancelling'; return true;
  }
  async cancelPersisted(runId: string): Promise<boolean> {
    const run = this.#require(runId);
    if (!run.persistent || !run.ready || !run.writer) throw new DefinitionError('PERSISTENT_RUN_NOT_READY');
    if (finished(run)) return false;
    run.view.cancelRequested = true; run.view.status = 'cancelling';
    await this.#checkpoint(run); return true;
  }
  #require(runId: string): Run { const run = this.#runs.get(runId); if (!run) throw new DefinitionError('UNKNOWN_WORKFLOW_RUN'); return run; }
  #create(compiled: CompiledWorkflow, runId: string, input: JsonValue, persistent = false): Run {
    const plan = getPlan(compiled);
    if (!isIdentifier(runId)) throw new DefinitionError('INVALID_RUN_ID');
    if (this.#runs.has(runId)) throw new DefinitionError('DUPLICATE_WORKFLOW_RUN');
    let value: JsonValue; try { value = snapshot(input); } catch { throw new DefinitionError('INVALID_WORKFLOW_INPUT'); }
    const steps: WorkflowStep[] = [], limits: WorkflowLimitEvent[] = [];
    const run: Run = { steps, limits, node: plan.definition.start, value, traversals: new Map(), persistent, ready: false, writer: null,
      view: { runId, workflowId: plan.definition.id, status: 'queued', currentNode: plan.definition.start,
        currentIdentity: null, cancelRequested: false, outcome: null, reason: null, issues: [], steps, limits, lastAccepted: null } };
    this.#runs.set(runId, run); return run;
  }
  start(compiled: CompiledWorkflow, runId: string, input: JsonValue): WorkflowRunHandle {
    const run = this.#create(compiled, runId, input);
    const completion = Promise.resolve().then(() => this.#execute(compiled, run));
    return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancel(runId) });
  }
  /** Writes checkpoints during normal execution. This does not enable restart/resume. */
  async startPersisted(compiled: CompiledWorkflow, runId: string, input: JsonValue, store: RunRecordStore): Promise<WorkflowPersistentRunHandle> {
    const run = this.#create(compiled, runId, input, true), plan = getPlan(compiled);
    try {
      run.writer = await CheckpointWriter.prepare(compiled, runId, store);
      run.writer.acceptValue(await run.writer.saveValue(plan.definition.start, plan.definition.input, run.value));
      await this.#checkpoint(run); run.ready = true;
    } catch (error) { this.#runs.delete(runId); throw error; }
    const completion = Promise.resolve().then(() => this.#execute(compiled, run));
    return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancelPersisted(runId) });
  }
  async #checkpoint(run: Run): Promise<void> {
    if (run.writer) await run.writer.write(run.view, { node: run.node, value: run.value, traversals: Object.fromEntries(run.traversals) });
  }
  async #execute(compiled: CompiledWorkflow, run: Run): Promise<WorkflowSnapshot> {
    const plan = getPlan(compiled);
    const end = async (status: MutableRun['status'], reason: string | null = null, issues: readonly WorkflowIssue[] = []): Promise<WorkflowSnapshot> => {
      const priorNode = run.view.currentNode, priorIdentity = run.view.currentIdentity;
      run.view.status = status; run.view.reason = reason; run.view.issues = snapshot(issues);
      // A failed run retains its failure location, especially when a port cannot prove stop.
      if (status !== 'failed') { run.node = null; run.view.currentNode = null; run.view.currentIdentity = null; }
      try { await this.#checkpoint(run); }
      catch (error) {
        run.view.status = 'failed'; run.view.reason = 'WORKFLOW_PERSISTENCE_FAILED';
        run.node = priorNode; run.view.currentNode = priorNode; run.view.currentIdentity = priorIdentity;
        throw error;
      }
      return snapshot(run.view);
    };
    try {
      while (true) {
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        if (run.steps.length >= plan.definition.maxSteps) return end('exhausted', 'MAX_STEPS_EXCEEDED');
        const node = run.node!, binding = plan.bindings.get(node)!;
        const identity: ExecutionIdentity = { runId: run.view.runId, nodeTaskId: `task-${run.steps.length + 1}`, attemptId: 'attempt-1', attemptNumber: 1 };
        run.view.status = 'running'; run.view.currentNode = node; run.view.currentIdentity = identity;
        await this.#checkpoint(run);
        let check: readonly WorkflowIssue[];
        try { check = snapshot(binding.executor.check(binding.component.inputContract, snapshot(run.value))); }
        catch { return end('failed', 'CONTRACT_CHECK_FAILED'); }
        if (!issuesValid(check)) return end('failed', 'INVALID_CONTRACT_DIAGNOSTICS');
        if (check.length) return end('failed', 'INVALID_NODE_INPUT', check);
        // The input validator is trusted code too and may synchronously request cancellation.
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        let result: WorkflowNodeResult;
        try { result = snapshot(await binding.executor.execute(snapshot(binding.component), snapshot(run.value), snapshot(identity), { requested: () => run.view.cancelRequested })); }
        catch { return end('failed', 'EXECUTION_STOP_UNCONFIRMED'); }
        if (!result || !isExecutionIdentity(result.identity) || Object.keys(result.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId' || !same(identity, result.identity) || result.componentId !== binding.component.id) return end('failed', 'EXECUTION_IDENTITY_MISMATCH');
        if (result.status === 'failed') {
          if (Object.keys(result).sort().join(',') !== 'code,componentId,identity,issues,status,stopped' || !isIdentifier(result.code)
            || typeof result.stopped !== 'boolean' || !issuesValid(result.issues)) return end('failed', 'INVALID_NODE_RESULT');
          run.steps.push({ node, result });
          if (!result.stopped) return end('failed', 'EXECUTION_STOP_UNCONFIRMED', result.issues);
          if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
          return end('failed', result.code, result.issues);
        }
        if (result.status !== 'accepted' || Object.keys(result).sort().join(',') !== 'componentId,identity,outcome,output,status'
          || !isIdentifier(result.outcome) || !binding.outcomes.has(result.outcome)) return end('failed', 'INVALID_NODE_RESULT');
        try { check = snapshot(binding.executor.check(binding.component.outcomes[result.outcome]!, snapshot(result.output))); }
        catch { return end('failed', 'CONTRACT_CHECK_FAILED'); }
        if (!issuesValid(check)) return end('failed', 'INVALID_CONTRACT_DIAGNOSTICS');
        if (check.length) return end('failed', 'INVALID_NODE_OUTPUT', check);
        // Archive actual accepted bytes before recording acceptance and its successor in one CAS.
        let saved: WorkflowCheckpointValue | undefined;
        try { saved = await run.writer?.saveValue(node, binding.outcomes.get(result.outcome)!, result.output); }
        catch { return end('failed', 'WORKFLOW_VALUE_PERSISTENCE_FAILED'); }
        if (saved) run.writer!.acceptValue(saved);
        const step = { node, result }; run.steps.push(step); run.view.lastAccepted = step; run.value = snapshot(result.output);
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        const { destination: to, exhausted, event } = advanceWorkflowRoute(compiled, node, result.outcome, run.steps.length, run.traversals);
        if (event) run.limits.push(event);
        if ('end' in to) { run.view.outcome = to.end; return end(exhausted ? 'exhausted' : 'succeeded', exhausted ? 'ROUTE_LIMIT_EXCEEDED' : null); }
        run.node = to.node; run.view.currentNode = to.node; run.view.currentIdentity = null;
        await this.#checkpoint(run);
      }
    } catch { return end('failed', 'WORKFLOW_INTERNAL_ERROR'); }
  }
}
