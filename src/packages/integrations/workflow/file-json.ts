import { mkdir, mkdtemp, lstat, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isExecutionIdentity, isIdentifier } from '@agentflow/domain';
import type { ComponentDefinition, ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { ArtifactError, DefinitionError, snapshotJson } from '@agentflow/engine';
import type { Cancellation, ContractRegistry, FileManifest, WorkflowCatalog, WorkflowContract, WorkflowIssue, WorkflowNodeExecutor, WorkflowNodeResult } from '@agentflow/engine';
import { FileWorkflowCatalog } from './files.js';
import type { FileWorkflowReceipt } from './files.js';

export interface FileJsonContext {
  readonly identity: ExecutionIdentity;
  readonly inputPath: string;
  readonly cancellation: Cancellation;
  readonly source: { readonly reference: JsonValue; readonly manifest: FileManifest; readonly receipt: FileWorkflowReceipt | null };
}
export type FileJsonTransform = (context: FileJsonContext) => Promise<{ readonly outcome: string; readonly output: JsonValue }>;
export interface FileJsonReceipt {
  readonly identity: ExecutionIdentity;
  readonly componentId: string;
  readonly predecessor: JsonValue;
  readonly input: FileManifest;
  readonly outcome: string;
  readonly output: JsonValue;
}
const clone = <T>(v: T): T => snapshotJson(v) as unknown as T;
const key = (i: ExecutionIdentity): string => JSON.stringify([i.runId, i.nodeTaskId, i.attemptId]);
interface Work { readonly identity: ExecutionIdentity; root: string | null; active: boolean; cleaning: boolean }

/** Explicit trusted Transform. File authority remains with the file catalog; JSON acceptance is separate. */
export class FileJsonWorkflowCatalog implements WorkflowCatalog, WorkflowNodeExecutor {
  readonly #bindings = new Map<string, { component: ComponentDefinition; transform: FileJsonTransform }>();
  readonly #fileIds = new Set<string>();
  readonly #jsonIds = new Set<string>();
  readonly #attempts = new Set<string>();
  readonly #receipts = new Map<string, FileJsonReceipt>();
  readonly #work = new Map<string, Work>();
  constructor(private readonly files: FileWorkflowCatalog, private readonly json: ContractRegistry, private readonly workRoot: string) {
    if (!isAbsolute(workRoot) || workRoot.includes('\0')) throw new DefinitionError('INVALID_TRANSFORM_WORK_ROOT');
  }
  register(component: ComponentDefinition, transform: FileJsonTransform): void {
    const c = clone(component);
    if (!c || Object.keys(c).sort().join(',') !== 'id,implementation,inputContract,kind,outcomes' || !isIdentifier(c.id) || !isIdentifier(c.implementation)
      || c.kind !== 'transform' || !c.outcomes || typeof c.outcomes !== 'object' || Array.isArray(c.outcomes) || !Object.keys(c.outcomes).length || Object.keys(c.outcomes).length > 32
      || Object.keys(c.outcomes).some(k => !isIdentifier(k)) || typeof transform !== 'function') throw new DefinitionError('INVALID_FILE_JSON_TRANSFORM');
    if (this.#bindings.has(c.id)) throw new DefinitionError('DUPLICATE_FILE_JSON_TRANSFORM');
    this.files.contract(c.inputContract);
    for (const id of Object.values(c.outcomes)) {
      if (!this.json.has(id)) throw new DefinitionError('UNKNOWN_CONTRACT');
      if (id === c.inputContract || this.#fileIds.has(id)) throw new DefinitionError('AMBIGUOUS_TRANSFORM_CONTRACT');
    }
    if (this.#jsonIds.has(c.inputContract)) throw new DefinitionError('AMBIGUOUS_TRANSFORM_CONTRACT');
    this.#fileIds.add(c.inputContract); for (const id of Object.values(c.outcomes)) this.#jsonIds.add(id);
    this.#bindings.set(c.id, { component: c, transform });
  }
  resolve(id: string): { component: ComponentDefinition; executor: WorkflowNodeExecutor } {
    const b = this.#bindings.get(id); if (!b) throw new DefinitionError('UNKNOWN_FILE_JSON_TRANSFORM'); return { component: clone(b.component), executor: this };
  }
  validate(component: ComponentDefinition): void {
    const b = this.#bindings.get(component.id); if (!b || !isDeepStrictEqual(b.component, component)) throw new DefinitionError('INVALID_FILE_JSON_TRANSFORM');
  }
  contract(id: string): WorkflowContract {
    if (this.#fileIds.has(id)) return this.files.contract(id);
    if (this.#jsonIds.has(id)) return { kind: 'json', id };
    throw new DefinitionError('UNKNOWN_TRANSFORM_CONTRACT');
  }
  contractDefinition(id: string): import('@agentflow/engine').WorkflowContractDefinition {
    return this.contract(id).kind === 'files' ? this.files.contractDefinition(id) : { kind: 'json', id, schema: this.json.definition(id) };
  }
  check(id: string, value: JsonValue): readonly WorkflowIssue[] {
    if (this.contract(id).kind === 'files') return this.files.check(id, value);
    const result = this.json.check(id, value); return result.valid ? [] : result.issues.map(i => ({ contractId: i.contractId, path: i.instancePath, rule: i.schemaPath, code: i.keyword }));
  }
  receipt(identity: ExecutionIdentity): FileJsonReceipt {
    const receipt = this.#receipts.get(key(identity));
    if (!receipt || !isDeepStrictEqual(receipt.identity, identity)) throw new DefinitionError('UNKNOWN_FILE_JSON_RECEIPT'); return clone(receipt);
  }
  matches(identity: ExecutionIdentity, output: JsonValue): boolean {
    try { return isDeepStrictEqual(this.receipt(identity).output, snapshotJson(output)); } catch { return false; }
  }
  async cleanup(identity: ExecutionIdentity): Promise<void> {
    const work = this.#work.get(key(identity)); if (!work) return;
    if (!isDeepStrictEqual(work.identity, identity) || work.active || work.cleaning) throw new DefinitionError('INVALID_TRANSFORM_CLEANUP');
    work.cleaning = true;
    try { if (work.root) await rm(work.root, { recursive: true, force: true }); this.#work.delete(key(identity)); } finally { work.cleaning = false; }
  }
  async execute(component: ComponentDefinition, input: JsonValue, identity: ExecutionIdentity, cancellation: Cancellation): Promise<WorkflowNodeResult> {
    const c = clone(component), i = clone(identity), predecessor = clone(input); this.validate(c);
    if (!isExecutionIdentity(i) || this.#attempts.has(key(i))) throw new DefinitionError('INVALID_TRANSFORM_ATTEMPT'); this.#attempts.add(key(i));
    const work: Work = { identity: i, root: null, active: true, cleaning: false }; this.#work.set(key(i), work);
    const failed = (code: string, issues: readonly WorkflowIssue[] = []): WorkflowNodeResult => ({ identity: clone(i), componentId: c.id, status: 'failed', code, stopped: true, issues });
    let phase = 'TRANSFORM_INPUT_FAILED';
    try {
      const checked = this.files.check(c.inputContract, predecessor); if (checked.length) return failed('INPUT_CONTRACT_FAILED', checked);
      const source = this.files.inspect(predecessor, i.runId);
      if (cancellation.requested()) return failed('CANCELLED');
      await mkdir(this.workRoot, { recursive: true, mode: 0o700 }); const rootStat = await lstat(this.workRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error();
      work.root = await mkdtemp(join(this.workRoot, 'transform-'));
      const inputPath = join(work.root, 'input'); await this.files.materialize(predecessor, i.runId, inputPath);
      if (cancellation.requested()) return failed('CANCELLED');
      phase = 'TRANSFORM_EXECUTION_FAILED';
      const result = clone(await this.#bindings.get(c.id)!.transform({ identity: clone(i), inputPath, cancellation,
        source: { reference: clone(predecessor), manifest: clone(source.manifest), receipt: clone(source.receipt) } }));
      if (!result || Object.keys(result).sort().join(',') !== 'outcome,output' || typeof result.outcome !== 'string' || !Object.hasOwn(c.outcomes, result.outcome)) return failed('INVALID_TRANSFORM_OUTCOME');
      const outputCheck = this.check(c.outcomes[result.outcome]!, result.output); if (outputCheck.length) return failed('OUTPUT_CONTRACT_FAILED', outputCheck);
      phase = 'TRANSFORM_CLEANUP_FAILED'; await rm(work.root, { recursive: true, force: true }); work.root = null;
      this.#receipts.set(key(i), clone({ identity: i, componentId: c.id, predecessor, input: source.manifest, outcome: result.outcome, output: result.output }));
      this.#work.delete(key(i)); return { identity: clone(i), componentId: c.id, status: 'accepted', outcome: result.outcome, output: clone(result.output) };
    } catch (error) { return failed(phase, error instanceof ArtifactError
      ? (error.issues.length ? error.issues : [{ path: error.path, rule: '', code: error.code }]).map(issue => ({ ...issue, contractId: c.inputContract })) : []); }
    finally { work.active = false; }
  }
}
