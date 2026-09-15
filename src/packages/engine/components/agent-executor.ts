import type { AgentDispatchBinding } from '../auth/types.js';
import type { InvocationResourcePlan, InvocationPhaseSink } from '../runner/phases.js';
import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import type { ArtifactStore, FileManifest, FileIssue } from '../contracts/files.js';
import { ArtifactError, FileContractRegistry } from '../contracts/files.js';
import type { HarnessTask, HarnessResult } from '../harness/types.js';
import type { RunnerResourceCheckpoint, RestoredRunnerResource, Cancellation, RunnerResult } from '../runner/types.js';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';

export interface AgentExecutionFacts {
  readonly runner: RunnerResult;
  readonly harness: HarnessResult | null;
  readonly version: string | null;
  readonly finalized: boolean;
  readonly diagnostics: readonly string[];
}
export interface AgentExecutionHandle {
  readonly facts: AgentExecutionFacts;
  retryCleanup(): Promise<void>;
  release(): Promise<void>;
}
/** Explicitly installed trusted application code, never a function supplied by a workflow document. */
export interface AgentExecutionDriver {
  readonly harness: string;
  dispatchBinding?(): AgentDispatchBinding;
  validate(task: HarnessTask): void;
  /** Actual installed execution definition; no credential reads or node execution. */
  definitionSnapshot?(task: HarnessTask): Promise<JsonValue>;
  resourcePlan?(task: HarnessTask): Promise<InvocationResourcePlan | null>;
  restorePhaseResource?(task: HarnessTask, phase: string, record: RunnerResourceCheckpoint): Promise<RestoredRunnerResource>;
  receiptDefinition?(task: HarnessTask): Promise<{ harness: string; version: string; imageId: string }>;
  /** Materialize this exact snapshot independently before executing; retain cleanup capabilities on failure. */
  run(task: HarnessTask, input: FileManifest, cancellation: Cancellation, phases?: InvocationPhaseSink): Promise<AgentExecutionHandle>;
}
export interface AgentExecutionRequest {
  readonly componentId: string;
  readonly identity: ExecutionIdentity;
  readonly prompt: string;
  readonly config: JsonValue;
  readonly outcomes: Readonly<Record<string, string>>;
  readonly input: { readonly contractId: string; readonly source: string }
    | { readonly contractId: string; readonly receiptId: string }
    | { readonly contractId: string; readonly snapshotId: string };
}
export interface ExecutionReceipt {
  readonly id: string;
  readonly identity: ExecutionIdentity;
  readonly componentId: string;
  readonly predecessor: string | null;
  readonly harness: string;
  readonly version: string;
  readonly imageId: string | null;
  readonly input: FileManifest;
  readonly output: FileManifest;
  readonly outcome: string;
}
export type AgentAcceptanceResult = { readonly identity: ExecutionIdentity; readonly componentId: string } & (
  { readonly status: 'accepted'; readonly receipt: ExecutionReceipt }
  | { readonly status: 'failed'; readonly code: string; readonly contractId: string | null; readonly issues: readonly FileIssue[] });

const clone = <T>(value: T): T => copyJson(value) as unknown as T;
const same = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;
const complete = (file: NonNullable<RunnerResult['capture']>['stdout'] | undefined): boolean => !!file && file.complete === true && file.truncated === false && !file.error
  && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.path === 'string';

/** Cleanup cannot turn a failed attempt into an accepted one. Public data is always a copy. */
export class AgentAttempt {
  #input: string | null;
  readonly #value: AgentAcceptanceResult;
  readonly #handle: AgentExecutionHandle | null;
  readonly #artifacts: ArtifactStore;
  constructor(value: AgentAcceptanceResult, handle: AgentExecutionHandle | null,
    artifacts: ArtifactStore, ownedInput: string | null) { this.#input = ownedInput; this.#value = clone(value); this.#handle = handle; this.#artifacts = artifacts; }
  get result(): AgentAcceptanceResult { return clone(this.#value); }
  toJSON(): AgentAcceptanceResult { return this.result; }
  /** Host inspection only; raw capture paths are deliberately absent from the receipt/toJSON view. */
  executionFacts(): AgentExecutionFacts | null { return this.#handle ? clone(this.#handle.facts) : null; }
  async retryCleanup(): Promise<void> { await this.#handle?.retryCleanup(); }
  async releaseExecution(): Promise<void> {
    await this.#handle?.release();
    if (this.#input !== null) { await this.#artifacts.release(this.#input); this.#input = null; }
  }
}

/** One-attempt acceptance and process-local evidence. Routing and persistent recovery belong elsewhere. */
export class AgentExecutor {
  readonly #attempts = new Set<string>();
  readonly #receipts = new Map<string, ExecutionReceipt>();
  readonly #released = new Set<string>();
  #sequence = 0;
  constructor(private readonly contracts: FileContractRegistry, private readonly artifacts: ArtifactStore,
    private readonly driver: AgentExecutionDriver) {
    if (!isIdentifier(driver.harness)) throw new DefinitionError('INVALID_AGENT_DRIVER');
  }

  /** Reuse is safe only for the identical installed store with a descriptor capability. */
  canReuseSnapshot(store: ArtifactStore): boolean { return store === this.artifacts && typeof store.inspect === 'function'; }

  dispatchBinding(): AgentDispatchBinding | undefined { return this.driver.dispatchBinding ? clone(this.driver.dispatchBinding()) : undefined; }

  receipt(id: string): ExecutionReceipt {
    const receipt = this.#receipts.get(id); if (!receipt) throw new DefinitionError('UNKNOWN_EXECUTION_RECEIPT');
    return clone(receipt);
  }

  async releaseOutput(id: string): Promise<void> {
    const receipt = this.receipt(id); if (this.#released.has(id)) return;
    await this.artifacts.release(receipt.output.id); this.#released.add(id);
  }

  /** Side-effect-free definition preflight; no Attempt reservation or input capture. */
  validate(request: AgentExecutionRequest): void { this.prepare(request); }

  async definitionSnapshot(request: AgentExecutionRequest): Promise<JsonValue> {
    const { task } = this.prepare(request);
    if (!this.driver.definitionSnapshot) throw new DefinitionError('EXECUTION_DEFINITION_UNAVAILABLE');
    return clone(await this.driver.definitionSnapshot(clone(task)));
  }

  async resourcePlan(request: AgentExecutionRequest): Promise<InvocationResourcePlan | null> {
    const { task } = this.prepare(request);
    if (!this.driver.resourcePlan) return null;
    if (!this.driver.restorePhaseResource || !this.driver.receiptDefinition) throw new DefinitionError('AGENT_PERSISTENCE_UNAVAILABLE');
    return clone(await this.driver.resourcePlan(clone(task)));
  }
  async restorePhaseResource(request: AgentExecutionRequest, phase: string, record: RunnerResourceCheckpoint): Promise<RestoredRunnerResource> {
    const { task } = this.prepare(request);
    if (!this.driver.restorePhaseResource) throw new DefinitionError('AGENT_PERSISTENCE_UNAVAILABLE');
    return this.driver.restorePhaseResource(clone(task), phase, clone(record));
  }
  async receiptDefinition(request: AgentExecutionRequest): Promise<{ harness: string; version: string; imageId: string }> {
    const { task } = this.prepare(request);
    if (!this.driver.receiptDefinition) throw new DefinitionError('AGENT_PERSISTENCE_UNAVAILABLE');
    return clone(await this.driver.receiptDefinition(clone(task)));
  }

  private prepare(request: AgentExecutionRequest) {
    let captured: AgentExecutionRequest;
    try { captured = clone(request); } catch { throw new DefinitionError('INVALID_AGENT_REQUEST'); }
    if (!captured || !isIdentifier(captured.componentId) || !isExecutionIdentity(captured.identity)
      || typeof captured.prompt !== 'string' || !captured.prompt.trim() || captured.prompt.length > 65536 || captured.prompt.includes('\0')
      || !captured.outcomes || typeof captured.outcomes !== 'object' || Array.isArray(captured.outcomes)
      || Object.keys(captured).some(key => !['componentId', 'identity', 'prompt', 'config', 'outcomes', 'input'].includes(key))) throw new DefinitionError('INVALID_AGENT_REQUEST');
    const outcomes = Object.entries(captured.outcomes);
    if (!outcomes.length || outcomes.length > 32 || outcomes.some(([key, value]) => !isIdentifier(key) || !isIdentifier(value))) throw new DefinitionError('INVALID_AGENT_OUTCOMES');
    const input = captured.input;
    if (!input || !isIdentifier(input.contractId) || Object.keys(input).sort().join(',') !== ('source' in input ? 'contractId,source' : 'receiptId' in input ? 'contractId,receiptId' : 'contractId,snapshotId')
      || ('source' in input ? typeof input.source !== 'string' || !input.source || input.source.includes('\0') : !isIdentifier('receiptId' in input ? input.receiptId : input.snapshotId))) throw new DefinitionError('INVALID_AGENT_INPUT');
    for (const id of [input.contractId, ...outcomes.map(([, id]) => id)]) this.contracts.definition(id);
    const identity: ExecutionIdentity = Object.freeze({ runId: captured.identity.runId, nodeTaskId: captured.identity.nodeTaskId,
      attemptId: captured.identity.attemptId, attemptNumber: captured.identity.attemptNumber });
    const task: HarnessTask = { identity, prompt: captured.prompt, config: captured.config, ...(outcomes.length === 1 ? {} : { outcomes: outcomes.map(([name]) => name) }) };
    try { this.driver.validate(clone(task)); } catch { throw new DefinitionError('INVALID_AGENT_CONFIGURATION'); }
    return { captured, outcomes, input, identity, task };
  }

  async execute(request: AgentExecutionRequest, cancellation: Cancellation = { requested: () => false }, phases?: InvocationPhaseSink): Promise<AgentAttempt> {
    const { captured, outcomes, input, identity, task } = this.prepare(request);
    let predecessor: ExecutionReceipt | null = null;
    if ('receiptId' in input) {
      predecessor = this.receipt(input.receiptId);
      if (predecessor.identity.runId !== identity.runId || predecessor.output.contractId !== input.contractId || this.#released.has(predecessor.id)) throw new DefinitionError('INVALID_PREDECESSOR_RECEIPT');
    }
    const attemptKey = JSON.stringify([identity.runId, identity.nodeTaskId, identity.attemptId]);
    if (this.#attempts.has(attemptKey)) throw new DefinitionError('DUPLICATE_AGENT_ATTEMPT');
    this.#attempts.add(attemptKey); // Reserve synchronously before the first await, including failed attempts.
    let handle: AgentExecutionHandle | null = null; let ownedInput: string | null = null;
    const failed = (code: string, error?: unknown, contractId: string | null = null): AgentAttempt => new AgentAttempt({ identity, componentId: captured.componentId, status: 'failed', code, contractId,
      issues: error instanceof ArtifactError ? error.issues.length ? error.issues : [{ path: error.path, rule: '', code: error.code }] : [] }, handle, this.artifacts, ownedInput);
    try { if (cancellation.requested()) return failed('CANCELLED'); } catch { return failed('CANCELLATION_CHECK_FAILED'); }
    let inputSnapshot: FileManifest;
    try {
      if ('snapshotId' in input) {
        if (!this.artifacts.inspect) throw new DefinitionError('SNAPSHOT_INPUT_UNAVAILABLE');
        inputSnapshot = clone(await this.artifacts.inspect(input.snapshotId));
        if (inputSnapshot.id !== input.snapshotId) return failed('INPUT_SNAPSHOT_MISMATCH');
      } else {
        inputSnapshot = predecessor ? clone(predecessor.output) : clone(await this.artifacts.capture((input as { source: string }).source, input.contractId));
        if (!predecessor) ownedInput = inputSnapshot.id;
      }
      if (inputSnapshot.contractId !== input.contractId) return failed('INPUT_CONTRACT_MISMATCH');
    } catch (error) { return failed('INPUT_CAPTURE_FAILED', error, input.contractId); }
    try { if (cancellation.requested()) return failed('CANCELLED'); } catch { return failed('CANCELLATION_CHECK_FAILED'); }
    try { handle = await this.driver.run(clone(task), clone(inputSnapshot), cancellation, phases); }
    catch (error) { return failed('AGENT_START_FAILED', error, input.contractId); }
    let facts: AgentExecutionFacts;
    try { facts = clone(handle.facts); } catch { return failed('INVALID_EXECUTION_FACTS'); }
    if (!facts || typeof facts !== 'object') return failed('INVALID_EXECUTION_FACTS');
    const runner = facts.runner, harness = facts.harness;
    if (!runner || !harness || !isExecutionIdentity(runner.identity) || !isExecutionIdentity(harness.identity)
      || !same(identity, runner.identity) || !same(identity, harness.identity)) return failed('EXECUTION_IDENTITY_MISMATCH');
    if (!Array.isArray(runner.diagnostics) || !Array.isArray(harness.diagnostics) || !Array.isArray(facts.diagnostics)) return failed('INVALID_EXECUTION_FACTS');
    if (runner.phase !== 'exited' || runner.exitCode !== 0 || runner.stop !== 'confirmed' || runner.cleanup !== 'removed'
      || !runner.resource || runner.diagnostics.length || facts.finalized !== true || facts.diagnostics.length) return failed('EXECUTION_NOT_SUCCESSFUL');
    if (!runner.capture || !complete(runner.capture.stdout) || !complete(runner.capture.stderr)) return failed('RAW_CAPTURE_INCOMPLETE');
    if (harness.status !== 'completed' || harness.harness !== this.driver.harness || harness.diagnostics.length || !isIdentifier(facts.version)) return failed('HARNESS_NOT_SUCCESSFUL');
    if (runner.capture.imageId !== null && !/^sha256:[a-f0-9]{64}$/.test(runner.capture.imageId)) return failed('INVALID_EXECUTION_IMAGE');
    const outcome = outcomes.length === 1 ? outcomes[0]![0] : harness.outcome;
    if (outcome === null || !Object.hasOwn(captured.outcomes, outcome) || outcomes.length === 1 && harness.outcome !== null) return failed('INVALID_AGENT_OUTCOME');
    let output: FileManifest;
    try { output = clone(await this.artifacts.capture(runner.capture.outputsPath, captured.outcomes[outcome]!)); }
    catch (error) { return failed('OUTPUT_CONTRACT_FAILED', error, captured.outcomes[outcome]!); }
    if (!output || !isIdentifier(output.id)) return failed('INVALID_OUTPUT_SNAPSHOT');
    if (output.contractId !== captured.outcomes[outcome]) {
      await this.artifacts.release(output.id); return failed('OUTPUT_CONTRACT_MISMATCH');
    }
    const receipt: ExecutionReceipt = { id: `receipt-${++this.#sequence}`, identity, componentId: captured.componentId,
      predecessor: predecessor?.id ?? null, harness: harness.harness, version: facts.version, imageId: runner.capture.imageId,
      input: inputSnapshot, output, outcome };
    this.#receipts.set(receipt.id, clone(receipt));
    return new AgentAttempt({ identity, componentId: captured.componentId, status: 'accepted', receipt }, handle, this.artifacts, ownedInput);
  }
}
