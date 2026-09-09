import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { ArtifactError, DefinitionError } from '@agentflow/engine';
import type { AgentAttempt, AgentExecutor, ArtifactStore, Cancellation, ExecutionReceipt, FileContractRegistry, FileManifest,
  ScriptAttempt, ScriptDefinition, ScriptEvidence, ScriptExecutor, WorkflowCatalog, WorkflowContract, WorkflowIssue, WorkflowNodeExecutor, WorkflowNodeResult } from '@agentflow/engine';

export interface FileFunctionContext {
  readonly identity: ExecutionIdentity;
  readonly inputPath: string;
  readonly workPath: string;
  readonly outputsPath: string;
  readonly cancellation: Cancellation;
}
/** Trusted host code: resolve only after all its writers have stopped. */
export type FileWorkflowFunction = (context: FileFunctionContext) => Promise<{ readonly outcome: string }>;
export interface FileWorkflowReceipt {
  readonly identity: ExecutionIdentity;
  readonly componentId: string;
  readonly predecessor: JsonValue;
  readonly input: FileManifest;
  readonly output: FileManifest;
  readonly outcome: string;
  readonly agent: ExecutionReceipt | null;
  readonly script: ScriptEvidence | null;
}
type Binding = { readonly component: ComponentDefinition } & (
  { readonly kind: 'function'; readonly run: FileWorkflowFunction }
  | { readonly kind: 'agent'; readonly executor: AgentExecutor; readonly prompt: string; readonly config: JsonValue }
  | { readonly kind: 'script'; readonly executor: ScriptExecutor; readonly definition: ScriptDefinition });
interface Reference {
  readonly runId: string;
  readonly manifest: FileManifest;
  readonly receipt: FileWorkflowReceipt | null;
  readonly release: () => Promise<void>;
  uses: number;
  releasing: boolean;
  released: boolean;
}
interface Resources {
  readonly identity: ExecutionIdentity;
  root: string | null;
  attempt: AgentAttempt | null;
  script: ScriptAttempt | null;
  stopped: boolean;
  pendingOutput: (() => Promise<void>) | null;
  cleaning: boolean;
  active: boolean;
}
const clone = <T>(value: T): T => structuredClone(value);
const key = (identity: ExecutionIdentity): string => JSON.stringify([identity.runId, identity.nodeTaskId, identity.attemptId]);
const sameIdentity = (a: ExecutionIdentity, b: ExecutionIdentity): boolean => key(a) === key(b) && a.attemptNumber === b.attemptNumber;
const content = (m: FileManifest): string => JSON.stringify([m.contractId, [...m.directories].sort(),
  m.files.map(f => [f.path, f.bytes, f.sha256, f.mediaType, f.rule]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
const sameFiles = (a: FileManifest, b: FileManifest): boolean => content(a) === content(b);
const safeBeforeStart = new Set(['CANCELLED', 'CANCELLATION_CHECK_FAILED', 'INPUT_CAPTURE_FAILED', 'INPUT_CONTRACT_MISMATCH']);

/** Local file IO and provenance adapter. Workflow compilation/scheduling remain portable. */
export class FileWorkflowCatalog implements WorkflowCatalog, WorkflowNodeExecutor {
  readonly #bindings = new Map<string, Binding>();
  readonly #references = new Map<string, Reference>();
  readonly #attempts = new Set<string>();
  readonly #resources = new Map<string, Resources>();
  constructor(private readonly contracts: FileContractRegistry, private readonly artifacts: ArtifactStore, private readonly workRoot: string) {
    if (!isAbsolute(workRoot) || workRoot.includes('\0')) throw new DefinitionError('INVALID_WORKFLOW_WORK_ROOT');
  }

  registerFunction(component: ComponentDefinition, run: FileWorkflowFunction): void {
    if (!['gate', 'transform'].includes(component.kind) || typeof run !== 'function') throw new DefinitionError('INVALID_FILE_FUNCTION');
    this.register({ component: clone(component), kind: 'function', run });
  }
  registerAgent(component: ComponentDefinition, executor: AgentExecutor, task: { readonly prompt: string; readonly config: JsonValue }): void {
    if (component.kind !== 'agent') throw new DefinitionError('INVALID_FILE_AGENT');
    this.register({ component: clone(component), kind: 'agent', executor, prompt: task.prompt, config: clone(task.config) });
  }
  registerScript(component: ComponentDefinition, executor: ScriptExecutor, definition: { readonly argv: readonly string[]; readonly timeoutMs: number }): void {
    if (!['gate', 'transform'].includes(component.kind) || Object.keys(definition).sort().join(',') !== 'argv,timeoutMs') throw new DefinitionError('INVALID_FILE_SCRIPT');
    this.register({ component: clone(component), kind: 'script', executor,
      definition: { argv: clone(definition.argv), timeoutMs: definition.timeoutMs, outcomes: Object.keys(component.outcomes) } });
  }
  private register(binding: Binding): void {
    const c = binding.component;
    if (!isIdentifier(c.id) || !isIdentifier(c.implementation) || !c.outcomes || Array.isArray(c.outcomes)
      || Object.keys(c).sort().join(',') !== 'id,implementation,inputContract,kind,outcomes'
      || !Object.keys(c.outcomes).length || Object.keys(c.outcomes).length > 32 || Object.keys(c.outcomes).some(id => !isIdentifier(id))) throw new DefinitionError('INVALID_FILE_COMPONENT');
    if (this.#bindings.has(c.id)) throw new DefinitionError('DUPLICATE_FILE_COMPONENT');
    this.validateBinding(binding); this.#bindings.set(c.id, binding);
  }
  private validateBinding(binding: Binding): void {
    const c = binding.component;
    if (binding.kind === 'script') binding.executor.validate(clone(binding.definition));
    for (const id of [c.inputContract, ...Object.values(c.outcomes)]) this.contract(id);
    if (binding.kind === 'agent') binding.executor.validate({ componentId: c.id,
      identity: { runId: 'preflight', nodeTaskId: 'preflight', attemptId: 'preflight', attemptNumber: 1 },
      prompt: binding.prompt, config: clone(binding.config), outcomes: c.outcomes,
      input: { contractId: c.inputContract, source: '/workflow-preflight/input' } });
  }
  resolve(id: string): { component: ComponentDefinition; executor: WorkflowNodeExecutor } {
    const b = this.#bindings.get(id); if (!b) throw new DefinitionError('UNKNOWN_FILE_COMPONENT');
    return { component: clone(b.component), executor: this };
  }
  validate(component: ComponentDefinition): void {
    const b = this.#bindings.get(component.id);
    if (!b || JSON.stringify(b.component) !== JSON.stringify(component)) throw new DefinitionError('FILE_COMPONENT_MISMATCH');
    this.validateBinding(b);
  }
  contract(id: string): WorkflowContract { this.contracts.definition(id); return { kind: 'files', id }; }
  contractDefinition(id: string): import('@agentflow/engine').WorkflowContractDefinition {
    const definition = this.contracts.definition(id);
    const ids = [...new Set(definition.rules.flatMap(rule => rule.jsonContract === undefined ? [] : [rule.jsonContract]))].sort();
    return { kind: 'files', id, definition, jsonContracts: Object.fromEntries(ids.map(ref => [ref, this.contracts.json.definition(ref)])) };
  }
  async executionDefinition(component: ComponentDefinition): Promise<JsonValue> {
    this.validate(component); const binding = this.#bindings.get(component.id)!;
    if (binding.kind !== 'script') throw new DefinitionError('EXECUTION_DEFINITION_UNAVAILABLE');
    return binding.executor.definitionSnapshot(clone(binding.definition));
  }
  private reference(value: JsonValue): Reference {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'fileRef'
      || typeof value['fileRef'] !== 'string') throw new DefinitionError('INVALID_WORKFLOW_FILE_REFERENCE');
    const ref = this.#references.get(value['fileRef']);
    if (!ref) throw new DefinitionError('UNKNOWN_WORKFLOW_FILE_REFERENCE');
    return ref;
  }
  private available(value: JsonValue, runId: string, contractId?: string): Reference {
    const ref = this.reference(value);
    if (ref.runId !== runId || ref.released || ref.releasing || contractId !== undefined && ref.manifest.contractId !== contractId) throw new DefinitionError('UNAVAILABLE_WORKFLOW_FILES');
    return ref;
  }
  private issue(runId: string, manifest: FileManifest, receipt: FileWorkflowReceipt | null, release: () => Promise<void>): JsonValue {
    const id = randomUUID(); this.#references.set(id, { runId, manifest: clone(manifest), receipt: clone(receipt), release, uses: 0, released: false, releasing: false });
    return { fileRef: id };
  }
  async prepareInput(runId: string, source: string, contractId: string): Promise<JsonValue> {
    if (!isIdentifier(runId)) throw new DefinitionError('INVALID_RUN_ID');
    this.contract(contractId);
    const manifest = await this.artifacts.capture(source, contractId);
    return this.issue(runId, manifest, null, () => this.artifacts.release(manifest.id));
  }
  inspect(value: JsonValue, runId: string): { manifest: FileManifest; receipt: FileWorkflowReceipt | null; released: boolean } {
    const ref = this.reference(value); if (ref.runId !== runId) throw new DefinitionError('UNAVAILABLE_WORKFLOW_FILES');
    return clone({ manifest: ref.manifest, receipt: ref.receipt, released: ref.released });
  }
  async materialize(value: JsonValue, runId: string, destination: string): Promise<void> {
    const ref = this.available(value, runId); ref.uses++;
    try { await this.artifacts.materialize(ref.manifest.id, destination); } finally { ref.uses--; }
  }
  async release(value: JsonValue, runId: string): Promise<void> {
    const ref = this.reference(value); if (ref.runId !== runId || ref.uses || ref.releasing) throw new DefinitionError('WORKFLOW_FILES_IN_USE');
    if (ref.released) return;
    ref.releasing = true;
    try { await ref.release(); ref.released = true; } finally { ref.releasing = false; }
  }
  check(contractId: string, value: JsonValue): readonly WorkflowIssue[] {
    try {
      this.contract(contractId); const ref = this.reference(value);
      if (ref.released || ref.releasing || ref.manifest.contractId !== contractId) throw new Error();
      return [];
    } catch { return [{ contractId, path: '', rule: '', code: 'INVALID_WORKFLOW_FILE_REFERENCE' }]; }
  }
  private stopped(resources: Resources): boolean {
    if (resources.script) return resources.script.stopped();
    const attempt = resources.attempt; if (!attempt) return resources.stopped;
    try {
      const facts = attempt.executionFacts();
      if (!facts) return attempt.result.status === 'failed' && safeBeforeStart.has(attempt.result.code);
      return isExecutionIdentity(facts.runner.identity) && sameIdentity(facts.runner.identity, resources.identity)
        && facts.runner.stop === 'confirmed' && facts.runner.cleanup === 'removed' && facts.finalized === true;
    } catch { return false; }
  }
  private async disposeExecution(resources: Resources): Promise<void> {
    if (!this.stopped(resources)) throw new DefinitionError('EXECUTION_STOP_UNCONFIRMED');
    await resources.attempt?.releaseExecution();
    await resources.script?.releaseExecution();
    if (resources.root) { await rm(resources.root, { recursive: true, force: true }); resources.root = null; }
  }
  /** Retry cleanup by the retained failed identity; never upgrade its Workflow result. */
  async cleanup(identity: ExecutionIdentity): Promise<void> {
    const resources = this.#resources.get(key(identity)); if (!resources) return;
    if (!sameIdentity(resources.identity, identity) || resources.cleaning || resources.active) throw new DefinitionError('INVALID_WORKFLOW_CLEANUP');
    resources.cleaning = true;
    try {
      await resources.attempt?.retryCleanup();
      await resources.script?.retryCleanup();
      await this.disposeExecution(resources);
      await resources.pendingOutput?.(); resources.pendingOutput = null;
      this.#resources.delete(key(identity));
    } finally { resources.cleaning = false; }
  }
  async execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation): Promise<WorkflowNodeResult> {
    component = clone(component); identity = clone(identity);
    this.validate(component);
    if (!isExecutionIdentity(identity) || this.#attempts.has(key(identity))) throw new DefinitionError('INVALID_FILE_WORKFLOW_ATTEMPT');
    this.#attempts.add(key(identity));
    const ownIdentity = clone(identity), predecessor = clone(input), b = this.#bindings.get(component.id)!;
    const resources: Resources = { identity: ownIdentity, root: null, attempt: null, script: null, stopped: true, pendingOutput: null, cleaning: false, active: true };
    this.#resources.set(key(identity), resources);
    let ref: Reference | null = null, phase = 'INPUT_MATERIALIZATION_FAILED', checkedContractId = component.inputContract;
    const failed = (code: string, error?: unknown, contractId = component.inputContract): Extract<WorkflowNodeResult, { status: 'failed' }> => ({ identity: clone(ownIdentity), componentId: component.id,
      status: 'failed', code, stopped: this.stopped(resources), issues: error instanceof ArtifactError
        ? (error.issues.length ? error.issues : [{ path: error.path, rule: '', code: error.code }]).map(issue => ({ ...issue, contractId })) : [] });
    try {
      ref = this.available(predecessor, identity.runId, component.inputContract); ref.uses++;
      if (cancellation.requested()) return failed('CANCELLED');
      await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.workRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new ArtifactError('INVALID_WORKFLOW_WORK_ROOT');
      resources.root = await mkdtemp(join(this.workRoot, 'node-'));
      const inputPath = join(resources.root, 'input'), workPath = join(resources.root, 'work'), outputsPath = join(resources.root, 'outputs');
      await this.artifacts.materialize(ref.manifest.id, inputPath);
      await mkdir(workPath, { mode: 0o700 }); await mkdir(outputsPath, { mode: 0o700 });
      if (cancellation.requested()) return failed('CANCELLED');
      let outcome: string, output: FileManifest, agent: ExecutionReceipt | null = null, script: ScriptEvidence | null = null;
      phase = 'FILE_NODE_EXECUTION_FAILED';
      if (b.kind === 'function') {
        const result = await b.run({ identity: clone(ownIdentity), inputPath, workPath, outputsPath, cancellation });
        if (!result || Object.keys(result).join(',') !== 'outcome' || typeof result.outcome !== 'string' || !Object.hasOwn(component.outcomes, result.outcome)) return failed('INVALID_FILE_OUTCOME');
        outcome = result.outcome;
        phase = 'OUTPUT_CONTRACT_FAILED'; checkedContractId = component.outcomes[outcome]!;
        output = await this.artifacts.capture(outputsPath, component.outcomes[outcome]!);
        resources.pendingOutput = () => this.artifacts.release(output.id);
      } else if (b.kind === 'script') {
        resources.stopped = false;
        resources.script = await b.executor.execute({ identity: clone(ownIdentity), inputSource: inputPath, definition: clone(b.definition) }, cancellation);
        const result = resources.script.result;
        if (result.status === 'failed') return failed(result.code);
        script = result.evidence; outcome = script.outcome;
        phase = 'OUTPUT_CONTRACT_FAILED'; checkedContractId = component.outcomes[outcome]!;
        output = await this.artifacts.capture(resources.script.executionFacts()!.capture!.outputsPath, checkedContractId);
        resources.pendingOutput = () => this.artifacts.release(output.id);
      } else {
        resources.stopped = false;
        resources.attempt = await b.executor.execute({ componentId: component.id, identity: clone(ownIdentity), prompt: b.prompt,
          config: clone(b.config), outcomes: clone(component.outcomes), input: { source: inputPath, contractId: component.inputContract } }, cancellation);
        const result = resources.attempt.result;
        if (result.status === 'failed') return { ...failed(result.code), issues: result.issues.map(issue => ({ ...issue, contractId: result.contractId ?? component.inputContract })) };
        agent = result.receipt;
        resources.pendingOutput = () => b.executor.releaseOutput(result.receipt.id);
        if (!sameFiles(ref.manifest, agent.input)) return failed('WORKFLOW_AGENT_INPUT_MISMATCH');
        outcome = agent.outcome; output = agent.output;
      }
      phase = 'FILE_NODE_CLEANUP_FAILED';
      await this.disposeExecution(resources);
      const receipt: FileWorkflowReceipt = { identity: ownIdentity, componentId: component.id, predecessor, input: ref.manifest, output, outcome, agent, script };
      const value = this.issue(identity.runId, output, receipt, resources.pendingOutput!);
      resources.pendingOutput = null; this.#resources.delete(key(identity));
      return { identity: clone(ownIdentity), componentId: component.id, status: 'accepted', outcome, output: value };
    } catch (error) { return failed(phase, error, checkedContractId); }
    finally { resources.active = false; if (ref) ref.uses--; }
  }
}
