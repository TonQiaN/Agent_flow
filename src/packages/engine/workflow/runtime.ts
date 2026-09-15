import {parallelSeeds,collectParallel} from '../parallel/records.js';
import {parallelMetadata,parallelEqual} from '../parallel/metadata.js';
import type {ParallelCheckpoint} from '../parallel/types.js';
import { decideRetry } from '../retry/policy.js';
import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import type { RunRecordStore } from '../persistence/types.js';
import { advanceWorkflowRoute } from './route.js';
import { CheckpointWriter, type WorkflowCheckpointValue } from './checkpoint.js';
import { consumeRecoveryHandoff } from './recovery-handoff.js';
import type { WorkflowRecoveryHandle } from './recovery.js';
import { workflowAttemptIdentity } from './attempt-history.js';
import { WorkflowRestoreError } from './restore-value.js';
import { getPlan, snapshot } from './compiler.js';
import type { CompiledWorkflow, WorkflowIssue, WorkflowNodeResult, WorkflowSnapshot, WorkflowStep, WorkflowLimitEvent } from './types.js';

type MutableRun = { -readonly [K in keyof WorkflowSnapshot]: WorkflowSnapshot[K] };
interface Run {
  view: MutableRun; steps: WorkflowStep[]; limits: WorkflowLimitEvent[];
  node: string | null; value: JsonValue; traversals: Map<string, number>;
  persistent: boolean; ready: boolean; writer: CheckpointWriter | null;
  nextAttempt: number; records:RunRecordStore|null; pendingParallel?:ParallelCheckpoint;
}
export interface WorkflowRunHandle { readonly completion: Promise<WorkflowSnapshot>; query(): WorkflowSnapshot; cancel(): boolean }
export interface WorkflowPersistentRunHandle { readonly completion: Promise<WorkflowSnapshot>; query(): WorkflowSnapshot; cancel(): Promise<boolean> }
export interface WorkflowResumedRunHandle extends WorkflowPersistentRunHandle { dispose(): Promise<void> }
const finished = (run: Run): boolean => ['succeeded', 'failed', 'cancelled', 'exhausted'].includes(run.view.status);
const same = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;
const issuesValid = (issues: readonly WorkflowIssue[]): boolean => Array.isArray(issues) && issues.length <= 1000 && issues.every(issue => !!issue
  && typeof issue === 'object' && Object.keys(issue).sort().join(',') === 'code,contractId,path,rule'
  && Object.values(issue).every(value => typeof value === 'string'));

/** One serial execution path. Optional checkpoints persist facts without introducing another scheduler. */
export class WorkflowRuntime {
  readonly #runs = new Map<string, Run>();
  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {}
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
    const waiting = run.view.status === 'retry_wait';
    run.view.cancelRequested = true; run.view.status = waiting ? 'cancelled' : 'cancelling';
    if (waiting) { delete run.view.retry; run.view.reason = 'CANCEL_REQUESTED'; run.node = null; run.view.currentNode = null; }
    await this.#checkpoint(run); return true;
  }
  #require(runId: string): Run { const run = this.#runs.get(runId); if (!run) throw new DefinitionError('UNKNOWN_WORKFLOW_RUN'); return run; }
  #create(compiled: CompiledWorkflow, runId: string, input: JsonValue, persistent = false): Run {
    const plan = getPlan(compiled);
    if (!isIdentifier(runId)) throw new DefinitionError('INVALID_RUN_ID');
    if (this.#runs.has(runId)) throw new DefinitionError('DUPLICATE_WORKFLOW_RUN');
    let value: JsonValue; try { value = snapshot(input); } catch { throw new DefinitionError('INVALID_WORKFLOW_INPUT'); }
    const steps: WorkflowStep[] = [], limits: WorkflowLimitEvent[] = [];
    const run: Run = { steps, limits, node: plan.definition.start, value, traversals: new Map(), persistent, ready: false, writer: null, records:null, nextAttempt: 1,
      view: { runId, workflowId: plan.definition.id, status: 'queued', currentNode: plan.definition.start,
        currentIdentity: null, cancelRequested: false, outcome: null, reason: null, issues: [], steps, limits, lastAccepted: null } };
    this.#runs.set(runId, run); return run;
  }
  start(compiled: CompiledWorkflow, runId: string, input: JsonValue): WorkflowRunHandle {
    if ([...getPlan(compiled).bindings.values()].some(b=>b.executor.parallel)) throw new DefinitionError('PARALLEL_REQUIRES_QUEUE');
    if (Object.values(getPlan(compiled).definition.nodes).some(n => n.retry)) throw new DefinitionError('RETRY_REQUIRES_PERSISTENCE');
    const run = this.#create(compiled, runId, input);
    const completion = Promise.resolve().then(() => this.#execute(compiled, run));
    return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancel(runId) });
  }
  /** Start a new durable Run; use resumePersisted with a claimed recovery handle to continue one. */
  async startPersisted(compiled: CompiledWorkflow, runId: string, input: JsonValue, store: RunRecordStore): Promise<WorkflowPersistentRunHandle> {
    await this.preparePersisted(compiled, runId, input, store);
    const run = this.#require(runId);
    const completion = Promise.resolve().then(() => this.#execute(compiled, run));
    return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancelPersisted(runId) });
  }
  /** Save the initial input and ready position without executing an Attempt. */
  async preparePersisted(compiled: CompiledWorkflow, runId: string, input: JsonValue, store: RunRecordStore): Promise<WorkflowSnapshot> {
    const run = this.#create(compiled, runId, input, true), plan = getPlan(compiled);
    try {
      run.records = store;
      run.writer = await CheckpointWriter.prepare(compiled, runId, store);
      run.writer.acceptValue(await run.writer.saveValue(plan.definition.start, plan.definition.input, run.value));
      await this.#checkpoint(run); run.ready = true;
    } catch (error) { this.#runs.delete(runId); throw error; }
    return this.query(runId);
  }
  /** Consume actual recovery ownership and reuse the normal execution loop with a new Attempt. */
  async resumePersisted(recovery: WorkflowRecoveryHandle): Promise<WorkflowResumedRunHandle> {
    return this.#resume(recovery, false);
  }
  /** A Worker returns after one node; normal acceptance and routing still own the successor. */
  async resumePersistedNode(recovery: WorkflowRecoveryHandle, cancelRequested = false): Promise<WorkflowResumedRunHandle> {
    return this.#resume(recovery, true, cancelRequested);
  }
  async #resume(recovery: WorkflowRecoveryHandle, yieldAfterNode: boolean, cancelRequested = false): Promise<WorkflowResumedRunHandle> {
    const data = consumeRecoveryHandoff(recovery), { compiled, checkpoint, store } = data, runId = checkpoint.snapshot.runId;
    let installed = false;
    try {
      if (this.#runs.has(runId)) throw new DefinitionError('DUPLICATE_WORKFLOW_RUN');
      const view = snapshot(checkpoint.snapshot), last = checkpoint.attempts.at(-1);
      if (view.status === 'retry_wait' && view.retry!.nextAt > this.clock.now()) throw new DefinitionError('RETRY_NOT_DUE');
      const interrupted = last?.resultStep === null && !last.retry && !last.parallel ? last : null;
      const nextAttempt = last?.resultStep === null ? last.identity.attemptNumber + (last.parallel ? 0 : 1) : 1;
      if (!Number.isSafeInteger(nextAttempt)) throw new DefinitionError('WORKFLOW_ATTEMPT_LIMIT');
      const run: Run = { view, steps: view.steps as WorkflowStep[], limits: view.limits as WorkflowLimitEvent[], node: checkpoint.cursor.node,
        value: snapshot(checkpoint.cursor.value), traversals: new Map(Object.entries(checkpoint.cursor.traversals)),
        persistent: true, ready: false, writer: null, records:store, nextAttempt, ...(last?.resultStep===null&&last.parallel?{pendingParallel:snapshot(last.parallel)}:{}) };
      if(cancelRequested){run.view.cancelRequested=true;run.view.status='cancelling';}
      run.view.currentIdentity = run.pendingParallel ? snapshot(last!.identity) : null;
      if(run.pendingParallel)run.view.status=run.view.cancelRequested?'cancelling':'running';
      if (checkpoint.snapshot.status === 'retry_wait') { if(!run.view.cancelRequested)run.view.status = 'running'; delete run.view.retry; }
      this.#runs.set(runId, run); installed = true;
      run.writer = await CheckpointWriter.resume(compiled, checkpoint, store, data.revision);
      await this.#checkpoint(run); run.ready = true;
      const completion = Promise.resolve().then(async () => {
        if (interrupted && getPlan(compiled).definition.nodes[interrupted.node]!.retry) {
          const binding = getPlan(compiled).bindings.get(interrupted.node)!;
          const result: Extract<WorkflowNodeResult, {status:'failed'}> = { identity: interrupted.identity, componentId: binding.component.id,
            status: 'failed', code: 'ATTEMPT_INTERRUPTED', stopped: true, issues: [] };
          if (await this.#retry(compiled, run, result, true)) return snapshot(run.view);
          if (run.view.cancelRequested) return this.#execute(compiled, run, yieldAfterNode);
          const exhausted = interrupted.identity.attemptNumber >= getPlan(compiled).definition.nodes[interrupted.node]!.retry!.maxAttempts;
          const failure = { ...result, code: exhausted ? 'ATTEMPT_BUDGET_EXHAUSTED' : result.code };
          run.steps.push({ node: interrupted.node, result: failure }); run.writer!.finishAttempt(run.steps.length - 1);
          run.view.status = 'failed'; run.view.reason = failure.code; run.view.currentIdentity = interrupted.identity;
          await this.#checkpoint(run); return snapshot(run.view);
        }
        return this.#execute(compiled, run, yieldAfterNode);
      });
      let disposing: Promise<void> | null = null;
      return Object.freeze({ completion, query: () => this.query(runId), cancel: () => this.cancelPersisted(runId),
        dispose: () => {
          if (disposing) return disposing;
          disposing = completion.catch(() => {}).then(() => data.dispose()).finally(() => { disposing = null; });
          return disposing;
        } });
    } catch (error) {
      if (installed) this.#runs.delete(runId);
      try { await data.dispose(); } catch { throw new WorkflowRestoreError('WORKFLOW_RESUME_DISPOSE_FAILED', data.dispose); }
      throw error;
    }
  }
  async #parallel(compiled:CompiledWorkflow,run:Run,identity:ExecutionIdentity):Promise<WorkflowNodeResult|null>{
    const binding=getPlan(compiled).bindings.get(run.node!)!, expansion=binding.executor.parallel!(snapshot(binding.component),snapshot(run.value));
    if(!run.records?.parallel||!run.writer)throw new DefinitionError('PARALLEL_REQUIRES_QUEUE');
    const metadata=parallelMetadata(expansion,identity,run.records.parallel);
    if(!run.pendingParallel){
      const seeds=await parallelSeeds(expansion,metadata);
      if(run.view.cancelRequested)return{identity,componentId:binding.component.id,status:'failed',code:'CANCELLED',stopped:true,issues:[]};
      run.pendingParallel=metadata;run.writer.parallelAttempt(metadata);
      run.view.status='parallel_wait';run.view.currentIdentity=null;
      await run.writer.write(run.view,{node:run.node,value:run.value,traversals:Object.fromEntries(run.traversals)},seeds);return null;
    }
    if(!parallelEqual(metadata,run.pendingParallel))throw new DefinitionError('PARALLEL_EXPANSION_MISMATCH');
    const collected=await collectParallel(expansion,metadata,run.records);
    if(collected.pending){run.view.status=run.view.cancelRequested?'cancelling':'parallel_wait';run.view.currentIdentity=null;await this.#checkpoint(run);return null;}
    const joinedIssues=collected.issues.length?[]:binding.executor.check(binding.component.outcomes[expansion.outcome]!,snapshot(collected.output));
    if(joinedIssues.length)return{identity,componentId:binding.component.id,status:'failed',code:'INVALID_PARALLEL_OUTPUT',stopped:true,issues:joinedIssues};
    return collected.issues.length?{identity,componentId:binding.component.id,status:'failed',code:'PARALLEL_CHILDREN_FAILED',stopped:true,issues:collected.issues}
      :{identity,componentId:binding.component.id,status:'accepted',outcome:expansion.outcome,output:collected.output};
  }
  async #retry(compiled: CompiledWorkflow, run: Run, result: Extract<WorkflowNodeResult,{status:'failed'}>, recovered = false): Promise<boolean> {
    const plan = getPlan(compiled), node = run.node!, binding = plan.bindings.get(node)!;
    const decision = decideRetry(plan.definition.nodes[node]!.retry, result.identity.attemptNumber, result.code, result.stopped, run.view.cancelRequested, this.clock.now());
    if (!decision) return false;
    if (!run.writer) throw new DefinitionError('RETRY_REQUIRES_PERSISTENCE');
    if (!recovered) {
      if (binding.component.kind === 'effect') {
        if (!binding.executor.checkRecovery) throw new DefinitionError('WORKFLOW_RESOURCE_RESTORE_UNAVAILABLE');
        await binding.executor.checkRecovery(snapshot(binding.component), snapshot(run.value), snapshot(result.identity));
      }
      await binding.executor.cleanupFailed?.(snapshot(result.identity));
    }
    // Cancellation may arrive while cleanup was awaited. Never publish a runnable retry then.
    if (run.view.cancelRequested) return false;
    run.writer.retryAttempt(result, decision);
    run.view.status = 'retry_wait'; run.view.currentIdentity = null; run.view.reason = null; run.view.issues = [];
    run.view.retry = { nodeTaskId: result.identity.nodeTaskId, attemptNumber: result.identity.attemptNumber, code: result.code, nextAt: decision.nextAt };
    await this.#checkpoint(run); return true;
  }
  async #checkpoint(run: Run): Promise<void> {
    if (run.writer) await run.writer.write(run.view, { node: run.node, value: run.value, traversals: Object.fromEntries(run.traversals) });
  }
  async #execute(compiled: CompiledWorkflow, run: Run, yieldAfterNode = false): Promise<WorkflowSnapshot> {
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
        if (run.view.cancelRequested && !run.pendingParallel) return end('cancelled', 'CANCEL_REQUESTED');
        if (run.steps.length >= plan.definition.maxSteps) return end('exhausted', 'MAX_STEPS_EXCEEDED');
        const node = run.node!, binding = plan.bindings.get(node)!;
        const identity = workflowAttemptIdentity(run.view.runId, run.steps.length + 1, run.nextAttempt);
        run.view.status = run.view.cancelRequested?'cancelling':'running'; run.view.currentNode = node; run.view.currentIdentity = identity;
        if(!run.pendingParallel)run.writer?.beginAttempt(node, identity);
        await this.#checkpoint(run);
        let check: readonly WorkflowIssue[];
        try { check = snapshot(binding.executor.check(binding.component.inputContract, snapshot(run.value))); }
        catch { return end('failed', 'CONTRACT_CHECK_FAILED'); }
        if (!issuesValid(check)) return end('failed', 'INVALID_CONTRACT_DIAGNOSTICS');
        if (check.length) {
          if(binding.executor.parallel){run.steps.push({node,result:{identity,componentId:binding.component.id,status:'failed',code:'INVALID_NODE_INPUT',stopped:true,issues:check}});run.writer?.finishAttempt(run.steps.length-1);}
          return end('failed', 'INVALID_NODE_INPUT', check);
        }
        // The input validator is trusted code too and may synchronously request cancellation.
        if (run.view.cancelRequested && !run.pendingParallel) return end('cancelled', 'CANCEL_REQUESTED');
        let result: WorkflowNodeResult;
        const persistence = run.writer?.resourceSink(node, identity, () => this.#checkpoint(run));
        const phases = run.writer?.phaseSink(node, identity, () => this.#checkpoint(run));
        try {
          if(binding.executor.parallel){const parallel=await this.#parallel(compiled,run,identity);if(parallel===null)return snapshot(run.view);if(run.view.cancelRequested)return end('cancelled','CANCEL_REQUESTED');result=parallel;}
          else result = snapshot(await binding.executor.execute(snapshot(binding.component), snapshot(run.value), snapshot(identity), { requested: () => run.view.cancelRequested }, persistence?.sink, phases?.sink)); }
        catch (error) {
          if(binding.executor.parallel&&!run.pendingParallel)result={identity,componentId:binding.component.id,status:'failed',code:error instanceof DefinitionError?error.code:'PARALLEL_EXPANSION_FAILED',stopped:true,issues:[]};
          else return end('failed', 'EXECUTION_STOP_UNCONFIRMED');
        }
        finally { persistence?.close(); phases?.close(); }
        if (!result || !isExecutionIdentity(result.identity) || Object.keys(result.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId' || !same(identity, result.identity) || result.componentId !== binding.component.id) return end('failed', 'EXECUTION_IDENTITY_MISMATCH');
        if (result.status === 'failed') {
          if (Object.keys(result).sort().join(',') !== 'code,componentId,identity,issues,status,stopped' || !isIdentifier(result.code)
            || typeof result.stopped !== 'boolean' || !issuesValid(result.issues)) return end('failed', 'INVALID_NODE_RESULT');
          if (await this.#retry(compiled, run, result)) return snapshot(run.view);
          run.steps.push({ node, result });
          run.writer?.finishAttempt(run.steps.length - 1);
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
        if (run.writer && !run.writer.phasesComplete(node)) return end('failed', 'WORKFLOW_PHASES_INCOMPLETE');
        // Archive actual accepted bytes before recording acceptance and its successor in one CAS.
        let saved: WorkflowCheckpointValue | undefined;
        try { saved = await run.writer?.saveValue(node, binding.outcomes.get(result.outcome)!, result.output, result); }
        catch { return end('failed', 'WORKFLOW_VALUE_PERSISTENCE_FAILED'); }
        if (saved) run.writer!.acceptValue(saved);
        const step = { node, result }; run.steps.push(step); run.view.lastAccepted = step; run.value = snapshot(result.output);
        run.writer?.finishAttempt(run.steps.length - 1);
        if (run.view.cancelRequested) return end('cancelled', 'CANCEL_REQUESTED');
        const { destination: to, exhausted, event } = advanceWorkflowRoute(compiled, node, result.outcome, run.steps.length, run.traversals);
        if (event) run.limits.push(event);
        if ('end' in to) { run.view.outcome = to.end; return end(exhausted ? 'exhausted' : 'succeeded', exhausted ? 'ROUTE_LIMIT_EXCEEDED' : null); }
        run.node = to.node; run.view.currentNode = to.node; run.view.currentIdentity = null;
        run.nextAttempt = 1; delete run.pendingParallel;
        await this.#checkpoint(run);
        if (yieldAfterNode) return snapshot(run.view);
      }
    } catch { return end('failed', 'WORKFLOW_INTERNAL_ERROR'); }
  }
}
