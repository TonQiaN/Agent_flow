import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { AgentExecutor, FileContractRegistry, snapshotJson } from '@agentflow/engine';
import type { ContractRegistry, AgentExecutionDriver, WorkflowCatalog, WorkflowNodeExecutor, Cancellation, RunnerResourceSink, InvocationPhaseSink, RunnerResourceCheckpoint, ScriptExecutor } from '@agentflow/engine';
import { FileArtifactStore } from '../artifacts/file-store.js';
import { FileArtifactArchive } from '../artifacts/file-archive.js';
import { FileWorkflowCatalog } from './files.js';
import { redactView } from '../observability/views.js';

interface Mapping {
  readonly revision: string;
  readonly input?: (input: JsonValue) => JsonValue;
  readonly output?: (input: JsonValue, output: JsonValue) => JsonValue;
  /** Trusted host selection, after output mapping; never read an outcome from model text. */
  readonly outcome?: (input: JsonValue, output: JsonValue) => string;
  readonly fault?: (input: JsonValue, identity: ExecutionIdentity) => boolean;
  readonly prepare?: (input: JsonValue, directory: string) => Promise<void>;
}
interface Binding { component: ComponentDefinition; inner: ComponentDefinition; mapping: Mapping }
/** A JSON node executed through existing file Agents/Scripts. No nested orchestrator or shell evaluation. */
export class JsonTaskWorkflowCatalog implements WorkflowCatalog, WorkflowNodeExecutor {
  readonly artifacts: FileArtifactStore;
  readonly archive: FileArtifactArchive;
  readonly files: FileWorkflowCatalog;
  readonly #bindings = new Map<string, Binding>();
  readonly #scripts = new Set<string>();
  constructor(private readonly json: ContractRegistry, private readonly root: string, private readonly record: (identity: ExecutionIdentity, value: JsonValue) => Promise<void>) {
    const contracts = new FileContractRegistry(json);
    this.artifacts = new FileArtifactStore(join(root, 'files'), contracts);
    this.archive = new FileArtifactArchive(join(root, 'archive'), contracts);
    this.files = new FileWorkflowCatalog(contracts, this.artifacts, join(root, 'nodes'), this.archive, async (identity, facts) => {
      const capture = facts.runner?.capture;
      await this.record(identity, redactView({ kind: 'execution', runner: facts.runner, agent: facts.agent ?? null, accepted: facts.accepted }));
      if (capture && !facts.agent) for (const stream of ['stdout', 'stderr'] as const) {
        const file = capture[stream];
        const data = file.bytes <= 1024 * 1024 ? await readFile(file.path, 'utf8').catch(() => '日志文件不可读') : '日志超过 1 MiB，未复制正文';
        await this.record(identity, redactView({ kind: stream, data, capture: file }));
      }
      if (capture && !facts.accepted && facts.runner?.stop === 'confirmed') {
        try { const draft = await this.archive.capture(capture.outputsPath, 'unaccepted-output'); await this.record(identity, { kind: 'artifact', accepted: false, saved: { schema: 'agentflow-workflow-files/v1', archive: snapshotJson(draft.reference), manifest: snapshotJson(draft.manifest) } }); }
        catch { await this.record(identity, { kind: 'capture_warning', reason: '失败草稿为空或超过保存限制，无法归档' }); }
      }
    });
    json.register('json-task-object', { anyOf: [{ type: 'object' }, { type: 'array' }] });
    contracts.register('unaccepted-output', { rules: [{ id: 'draft', kind: 'file', match: '**/*', minCount: 0, maxCount: 64, maxBytes: 64 * 1024 ** 2, mediaTypes: ['application/json', 'application/pdf', 'application/octet-stream', 'text/plain', 'text/markdown', 'text/html', 'image/png', 'image/jpeg'] }], maxFiles: 64, maxTotalBytes: 64 * 1024 ** 2, unmatched: 'reject' });
    const request = { id: 'request', kind: 'file' as const, match: 'request.json', minCount: 1, maxCount: 1, maxBytes: 16 * 1024 ** 2, mediaTypes: ['application/json'], jsonContract: 'json-task-object' };
    contracts.register('json-task-input', { rules: [request, { id: 'documents', kind: 'tree', match: 'documents', minCount: 0, maxCount: 1, minFiles: 1, maxFiles: 64, maxBytes: 128 * 1024 ** 2, mediaTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'application/octet-stream'] }], maxFiles: 65, maxTotalBytes: 144 * 1024 ** 2, unmatched: 'reject' });
    contracts.register('json-task-output', { rules: [{ ...request, id: 'result', match: 'result.json' }, { id: 'reports', kind: 'tree', match: 'reports', minCount: 0, maxCount: 1, minFiles: 1, maxFiles: 64, maxBytes: 64 * 1024 ** 2, mediaTypes: ['application/json', 'application/pdf', 'text/plain', 'text/markdown', 'text/html'] }], maxFiles: 65, maxTotalBytes: 80 * 1024 ** 2, unmatched: 'reject' });
  }
  #register(component: ComponentDefinition, mapping: Mapping): Binding {
    const outcomes = Object.values(component.outcomes);
    if (this.#bindings.has(component.id) || !mapping.revision || !outcomes.length || outcomes.length > 1 && !mapping.outcome) throw new Error('INVALID_JSON_TASK_BINDING');
    this.json.definition(component.inputContract); outcomes.forEach(id => this.json.definition(id));
    const binding = { component: structuredClone(component), mapping, inner: { ...component, inputContract: 'json-task-input', outcomes: { completed: 'json-task-output' } } };
    this.#bindings.set(component.id, binding); return binding;
  }
  registerAgent(component: ComponentDefinition, driver: AgentExecutionDriver, task: { prompt: string; config: JsonValue }, mapping: Mapping): void {
    const b = this.#register(component, mapping);
    this.files.registerAgent(b.inner, new AgentExecutor(this.artifacts.contracts, this.artifacts, driver), task);
  }
  registerScript(component: ComponentDefinition, executor: ScriptExecutor, definition: { argv: readonly string[]; timeoutMs: number }, mapping: Mapping): void {
    const b = this.#register(component, mapping); this.files.registerScript(b.inner, executor, definition); this.#scripts.add(component.id);
  }
  #get(id: string): Binding { const b = this.#bindings.get(id); if (!b) throw new Error('UNKNOWN_JSON_TASK'); return b; }
  resolve(id: string): { component: ComponentDefinition; executor: WorkflowNodeExecutor } { return { component: structuredClone(this.#get(id).component), executor: this }; }
  validate(component: ComponentDefinition): void { this.#get(component.id); }
  contract(id: string) { this.json.definition(id); return { kind: 'json' as const, id }; }
  contractDefinition(id: string) { return { ...this.contract(id), schema: this.json.definition(id) }; }
  check(id: string, value: JsonValue) { const result = this.json.check(id, value); return result.valid ? [] : result.issues.map(i => ({ contractId: id, path: i.instancePath, rule: i.schemaPath, code: i.keyword })); }
  async executionDefinition(component: ComponentDefinition): Promise<JsonValue> {
    const b = this.#get(component.id);
    return snapshotJson({ schema: 'agentflow-json-task/v1', mappingRevision: b.mapping.revision, execution: await this.files.executionDefinition(b.inner) });
  }
  dispatchBinding(component: ComponentDefinition) { return this.files.dispatchBinding(this.#get(component.id).inner); }
  async resourcePlan(component: ComponentDefinition) {
    const inner = this.#get(component.id).inner;
    return this.#scripts.has(component.id) ? { schema: 'agentflow-invocation-resources/v1' as const, phases: [{ id: 'script', kind: 'resource' as const, execution: await this.files.resourceDefinition(inner) }] } : this.files.resourcePlan(inner);
  }
  restorePhaseResource(component: ComponentDefinition, phase: string, record: RunnerResourceCheckpoint) {
    if (this.#scripts.has(component.id) && phase === 'script') return this.files.restoreResource(this.#get(component.id).inner, record);
    return this.files.restorePhaseResource(this.#get(component.id).inner, phase, record);
  }
  async checkRecovery(): Promise<void> { /* JSON is self-contained; resources are fenced by their actual phase owners. */ }
  async execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation, persistence?: RunnerResourceSink, phases?: InvocationPhaseSink) {
    const binding = this.#get(component.id);
    if (binding.mapping.fault?.(input, identity)) {
      await this.record(identity, { kind: 'test_fault', scenario: 'explicit-fixture', reason: 'IMPLEMENTATION_FAILED' });
      return { identity, componentId: component.id, status: 'failed' as const, code: 'IMPLEMENTATION_FAILED', stopped: true, issues: [] };
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.root, 'json-')); let prepared: JsonValue | undefined, output: JsonValue | undefined;
    try {
      const source = join(directory, 'input'); await mkdir(source, { mode: 0o700 });
      await writeFile(join(source, 'request.json'), JSON.stringify(binding.mapping.input?.(input) ?? input), { mode: 0o600 });
      await binding.mapping.prepare?.(input, source);
      prepared = await this.files.prepareInput(identity.runId, source, 'json-task-input');
      const phase = this.#scripts.has(component.id) ? await phases?.enter('script') : undefined;
      const result = await this.files.execute(binding.inner, prepared, identity, cancellation, phase?.resource ?? persistence, this.#scripts.has(component.id) ? undefined : phases);
      if (phase && (result.status === 'accepted' || result.stopped)) await phase.complete();
      if (result.status === 'failed') return result;
      output = result.output;
      const archived = await this.files.checkpointValue(output, identity.runId, 'json-task-output');
      await this.files.materialize(output, identity.runId, join(directory, 'result'));
      let value: JsonValue, outcome: string;
      try {
        value = snapshotJson(JSON.parse(await readFile(join(directory, 'result/result.json'), 'utf8')));
        value = binding.mapping.output?.(input, value) ?? value;
        outcome = binding.mapping.outcome?.(input, value) ?? Object.keys(component.outcomes)[0]!;
        if (!Object.hasOwn(component.outcomes, outcome)) throw new Error('UNDECLARED_JSON_TASK_OUTCOME');
      }
      catch { await this.record(identity, { kind: 'artifact', accepted: false, saved: archived }); return { identity, componentId: component.id, status: 'failed' as const, code: 'INVALID_AGENT_JSON', stopped: true, issues: [] }; }
      const issues = this.check(component.outcomes[outcome]!, value);
      await this.record(identity, { kind: 'artifact', accepted: issues.length === 0, saved: archived });
      if (issues.length) return { identity, componentId: component.id, status: 'failed' as const, code: 'INVALID_AGENT_JSON', stopped: true, issues };
      return { identity, componentId: component.id, status: 'accepted' as const, outcome, output: value };
    } finally {
      if (output !== undefined) await this.files.release(output, identity.runId);
      if (prepared !== undefined) await this.files.release(prepared, identity.runId);
      await this.files.cleanup(identity); await rm(directory, { recursive: true, force: true });
    }
  }
}
