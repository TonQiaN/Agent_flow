import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { getPlan, routeKey, snapshot } from './compiler.js';
import type { CompiledWorkflow, WorkflowIssue, WorkflowNodeResult, WorkflowSnapshot, WorkflowStep, WorkflowLimitEvent } from './types.js';

type MutableRun = { -readonly [K in keyof WorkflowSnapshot]: WorkflowSnapshot[K] };
interface Run { view: MutableRun; steps: WorkflowStep[]; limits: WorkflowLimitEvent[] }
export interface WorkflowRunHandle { readonly completion: Promise<WorkflowSnapshot>; query(): WorkflowSnapshot; cancel(): boolean }
const finished = (run: Run): boolean => ['succeeded', 'failed', 'cancelled', 'exhausted'].includes(run.view.status);
const same = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;
const issuesValid = (issues: readonly WorkflowIssue[]): boolean => Array.isArray(issues) && issues.length <= 1000 && issues.every(issue => !!issue
  && typeof issue === 'object' && Object.keys(issue).sort().join(',') === 'code,contractId,path,rule'
  && Object.values(issue).every(value => typeof value === 'string'));

/** In-memory serial control. Concrete execution, IO and business roles remain in installed ports. */
export class WorkflowRuntime {
  readonly #runs = new Map<string, Run>();
  query(runId: string): WorkflowSnapshot { return snapshot(this.#require(runId).view); }
  cancel(runId: string): boolean {
    const run = this.#require(runId); if (finished(run)) return false;
    run.view.cancelRequested = true; run.view.status = 'cancelling'; return true;
  }
  #require(runId: string): Run { const run = this.#runs.get(runId); if (!run) throw new DefinitionError('UNKNOWN_WORKFLOW_RUN'); return run; }
  start(compiled: CompiledWorkflow, runId: string, input: JsonValue): WorkflowRunHandle {
    const plan = getPlan(compiled);
    if (!isIdentifier(runId)) throw new DefinitionError('INVALID_RUN_ID');
    if (this.#runs.has(runId)) throw new DefinitionError('DUPLICATE_WORKFLOW_RUN');
    let value: JsonValue; try { value = snapshot(input); } catch { throw new DefinitionError('INVALID_WORKFLOW_INPUT'); }
    const steps: WorkflowStep[] = [], limits: WorkflowLimitEvent[] = [];
    const run: Run = { steps, limits, view: { runId, workflowId: plan.definition.id, status: 'queued', currentNode: plan.definition.start,
      currentIdentity: null, cancelRequested: false, outcome: null, reason: null, issues: [], steps, limits, lastAccepted: null } };
    this.#runs.set(runId, run);
    const completion = Promise.resolve().then(() => this.#execute(compiled, run, value));
    return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancel(runId) });
  }
  async #execute(compiled: CompiledWorkflow, run: Run, initial: JsonValue): Promise<WorkflowSnapshot> {
    const plan = getPlan(compiled); let value = initial; let node = plan.definition.start;
    const traversals = new Map<string, number>();
    const end = (status: MutableRun['status'], reason: string | null = null, issues: readonly WorkflowIssue[] = []): WorkflowSnapshot => {
      run.view.status = status; run.view.reason = reason; run.view.issues = snapshot(issues);
      // A failed run retains its failure location, especially when a port cannot prove stop.
      if (status !== 'failed') { run.view.currentNode = null; run.view.currentIdentity = null; }
      return snapshot(run.view);
    };
    try {
      while (true) {
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        if (run.steps.length >= plan.definition.maxSteps) return end('exhausted', 'MAX_STEPS_EXCEEDED');
        const binding = plan.bindings.get(node)!; const identity: ExecutionIdentity = { runId: run.view.runId, nodeTaskId: `task-${run.steps.length + 1}`, attemptId: 'attempt-1', attemptNumber: 1 };
        run.view.status = 'running'; run.view.currentNode = node; run.view.currentIdentity = identity;
        let check: readonly WorkflowIssue[];
        try { check = snapshot(binding.executor.check(binding.component.inputContract, snapshot(value))); }
        catch { return end('failed', 'CONTRACT_CHECK_FAILED'); }
        if (!issuesValid(check)) return end('failed', 'INVALID_CONTRACT_DIAGNOSTICS');
        if (check.length) return end('failed', 'INVALID_NODE_INPUT', check);
        // The input validator is trusted code too and may synchronously request cancellation.
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        let result: WorkflowNodeResult;
        try { result = snapshot(await binding.executor.execute(snapshot(binding.component), snapshot(value), snapshot(identity), { requested: () => run.view.cancelRequested })); }
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
        const step = { node, result }; run.steps.push(step); run.view.lastAccepted = step;
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        const key = routeKey(node, result.outcome); const route = plan.routes.get(key)!; const count = traversals.get(key) ?? 0;
        const exhausted = route.limit !== undefined && count >= route.limit.max;
        const to = exhausted ? route.limit!.exhausted : route.to;
        if (exhausted) run.limits.push({ node, outcome: result.outcome, step: run.steps.length, max: route.limit!.max });
        else traversals.set(key, count + 1);
        value = snapshot(result.output);
        if ('end' in to) { run.view.outcome = to.end; return end(exhausted ? 'exhausted' : 'succeeded', exhausted ? 'ROUTE_LIMIT_EXCEEDED' : null); }
        node = to.node;
      }
    } catch { return end('failed', 'WORKFLOW_INTERNAL_ERROR'); }
  }
}
