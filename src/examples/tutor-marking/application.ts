import { cp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentExecutor, ContractRegistry, FileContractRegistry, WorkflowRuntime, compileWorkflow } from '@agentflow/engine';
import type { AgentExecutionDriver, ArtifactStore, FileManifest, WorkflowDefinition, WorkflowSnapshot } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';
import { localWorkflowHistory, FileArtifactStore, FileWorkflowCatalog } from '@agentflow/integrations';
import type { FileFunctionContext } from '@agentflow/integrations';
import { sourceByteBudget } from '../tutor-tools/source-budget.js';
import { invokeTutorTool } from '../tutor-tools/process.js';

export interface MarkingAgent { readonly id: string; readonly prompt: string; readonly config: JsonValue }
export interface TutorMarkingSetup<D extends AgentExecutionDriver> {
  readonly source: string;
  readonly tutorWorkspace: string;
  readonly python: string;
  readonly marker: MarkingAgent;
  readonly reviewer: MarkingAgent;
  /** User-selected repair agent and route budget. Omit for immediate rejection. */
  readonly repair?: { readonly agent: MarkingAgent; readonly maxRounds: number };
  readonly driver: (artifacts: ArtifactStore) => D;
  readonly toolTimeoutMs?: number;
  readonly maxSourceBytes?: number;
}
export interface MarkingRun { readonly input: JsonValue; readonly snapshot: WorkflowSnapshot }
const toolchain = fileURLToPath(new URL('./toolchain.py', import.meta.url));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const reviewFiles = ['trusted/candidate-gate-report.json', 'trusted/marking-review-input.json'];
function contracts(maxSourceBytes: number) {
  const json = new ContractRegistry(); json.register('tutor-object', { type: 'object' });
  const registry = new FileContractRegistry(json);
  const file = (path: string) => ({ id: path.replaceAll('/', '-'), kind: 'file' as const, match: path, minCount: 1, maxCount: 1,
    maxBytes: 16 * 1024 ** 2, mediaTypes: ['application/json'], jsonContract: 'tutor-object' });
  const source = [{ id: 'source', kind: 'tree' as const, match: 'source', minCount: 1, maxCount: 1, minFiles: 1, maxFiles: 1000,
    maxBytes: maxSourceBytes, mediaTypes: ['application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'text/plain', 'text/markdown', 'text/x-python', 'application/octet-stream'] }];
  const candidate = [...source, ...['assessment-reference', 'submission-mapping', 'marking-candidate'].map(p => file(`candidate/${p}.json`))];
  const reviewInput = [...candidate, ...reviewFiles.map(file)], reviewed = [...reviewInput, file('trusted/marking-reviewer-result.json')];
  for (const [id, rules] of [['scan-source', source], ['scan-candidate', candidate], ['scan-review-input', reviewInput], ['scan-reviewed', reviewed],
    ['scan-final', [...reviewed, file('trusted/final-gate-report.json')]]] as const) {
    registry.register(id, { rules, maxFiles: 1100, maxTotalBytes: 768 * 1024 ** 2, unmatched: 'reject' });
  }
  return registry;
}

/** Application roles remain outside the engine. Each Agent is a separate normal invocation. */
export async function createTutorMarkingApplication<D extends AgentExecutionDriver>(root: string, setup: TutorMarkingSetup<D>) {
  const source = resolve(setup.source), workspace = resolve(setup.tutorWorkspace), python = resolve(setup.python);
  const marker = structuredClone(setup.marker), reviewer = structuredClone(setup.reviewer), repair = structuredClone(setup.repair);
  const timeout = setup.toolTimeoutMs ?? 120000;
  const reserved = new Set(['scan-intake', 'candidate-gate', 'final-gate', 'prepare-repair']);
  for (const binding of [marker, reviewer, ...(repair ? [repair.agent] : [])]) {
    if (reserved.has(binding.id)) throw new Error('INVALID_MARKING_AGENT_ID'); reserved.add(binding.id);
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 || (repair && (!Number.isSafeInteger(repair.maxRounds) || repair.maxRounds < 1 || repair.maxRounds > 100))) throw new Error('INVALID_MARKING_SETUP');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const maxSourceBytes = sourceByteBudget(setup.maxSourceBytes);
  const registered = contracts(maxSourceBytes), history = await localWorkflowHistory('tutor-marking', registered), store = new FileArtifactStore(join(root, 'artifacts'), registered, { maxTotalBytes: Math.max(256 * 1024 ** 2, maxSourceBytes + 128 * 1024 ** 2) }), files = new FileWorkflowCatalog(registered, store, join(root, 'nodes'), history.archive);
  const driver = setup.driver(store), agents = new AgentExecutor(registered, store, driver), runtime = new WorkflowRuntime(undefined, value => observe(value));
  let observe: import('@agentflow/engine').WorkflowObserver = async () => {};
  const originals = new Map<string, FileManifest>(), completed = new Map<string, MarkingRun>(), runIds = new Set<string>();
  const component = (id: string, kind: 'agent' | 'transform' | 'gate', inputContract: string, outcomes: Record<string, string>) => ({ id, kind, implementation: id, inputContract, outcomes });
  const current = (ctx: FileFunctionContext) => {
    const result = runtime.query(ctx.identity.runId).lastAccepted?.result;
    if (result?.status !== 'accepted') throw new Error('MARKING_PREDECESSOR_REQUIRED');
    return files.inspect(result.output, ctx.identity.runId);
  };
  const verify = async (ctx: FileFunctionContext, manifest: FileManifest, include: (path: string) => boolean) => {
    const previous = runtime.query(ctx.identity.runId).lastAccepted?.result;
    const incoming = previous?.status === 'accepted' ? files.inspect(previous.output, ctx.identity.runId).manifest : originals.get(ctx.identity.runId)!;
    const names = (m: FileManifest) => m.files.filter(f => include(f.path)).map(f => f.path).sort().join('\n');
    if (names(incoming) !== names(manifest)) throw new Error('MARKING_PROTECTED_FILES_CHANGED');
    for (const f of manifest.files.filter(f => include(f.path))) if (hash(await readFile(join(ctx.inputPath, f.path))) !== f.sha256) throw new Error('MARKING_PROTECTED_FILES_CHANGED');
  };
  const original = (ctx: FileFunctionContext) => verify(ctx, originals.get(ctx.identity.runId)!, p => p.startsWith('source/'));
  const invoke = (operation: string, ctx: FileFunctionContext) => invokeTutorTool(toolchain, python, workspace, operation, ctx, {}, timeout);
  files.registerFunction(component('scan-intake', 'transform', 'scan-source', { completed: 'scan-source' }), async ctx => { await original(ctx); return invoke('intake', ctx); });
  files.registerAgent(component(marker.id, 'agent', 'scan-source', { completed: 'scan-candidate' }), agents, marker);
  files.registerFunction(component('candidate-gate', 'gate', 'scan-candidate', { passed: 'scan-review-input', rejected: 'scan-review-input' }), async ctx => {
    await original(ctx);
    if (current(ctx).receipt?.componentId !== marker.id) throw new Error('MARKER_RECEIPT_REQUIRED');
    return invoke('candidate', ctx);
  });
  for (const binding of [reviewer, ...(repair ? [repair.agent] : [])]) files.registerAgent(component(binding.id, 'agent', 'scan-review-input', { completed: 'scan-reviewed' }), agents, binding);
  files.registerFunction(component('final-gate', 'gate', 'scan-reviewed', { passed: 'scan-final', rejected: 'scan-final' }), async ctx => {
    await original(ctx);
    const receipt = current(ctx).receipt;
    if (!receipt || ![reviewer.id, ...(repair ? [repair.agent.id] : [])].includes(receipt.componentId) || receipt.outcome !== 'completed' || !receipt.agent) throw new Error('REVIEWER_RECEIPT_REQUIRED');
    const preparation = files.inspect(receipt.predecessor, ctx.identity.runId);
    const first = receipt.componentId === reviewer.id;
    if (preparation.released || preparation.receipt?.componentId !== (first ? 'candidate-gate' : 'prepare-repair') || preparation.receipt.outcome !== (first ? 'passed' : 'completed')) throw new Error('REVIEW_PREPARATION_REQUIRED');
    await verify(ctx, preparation.manifest, p => reviewFiles.includes(p));
    return invoke('final', ctx);
  });
  if (repair) files.registerFunction(component('prepare-repair', 'transform', 'scan-final', { completed: 'scan-review-input' }), async ctx => {
    await original(ctx);
    const receipt = current(ctx).receipt;
    if (receipt?.componentId !== 'final-gate' || receipt.outcome !== 'rejected') throw new Error('REJECTED_GATE_REQUIRED');
    return invoke('repair', ctx);
  });
  const definition: WorkflowDefinition = { id: 'tutor-scanned-marking', start: 'intake', maxSteps: 5 + (repair?.maxRounds ?? 0) * 3,
    input: { kind: 'files', id: 'scan-source' }, outcomes: { completed: { kind: 'files', id: 'scan-final' }, rejected: { kind: 'files', id: 'scan-final' }, invalid: { kind: 'files', id: 'scan-review-input' } },
    nodes: { intake: { component: 'scan-intake' }, marker: { component: marker.id }, candidateGate: { component: 'candidate-gate' }, reviewer: { component: reviewer.id }, finalGate: { component: 'final-gate' },
      ...(repair ? { repairInput: { component: 'prepare-repair' }, repair: { component: repair.agent.id } } : {}) },
    routes: [{ from: 'intake', outcome: 'completed', to: { node: 'marker' } }, { from: 'marker', outcome: 'completed', to: { node: 'candidateGate' } },
      { from: 'candidateGate', outcome: 'passed', to: { node: 'reviewer' } }, { from: 'candidateGate', outcome: 'rejected', to: { end: 'invalid' } },
      { from: 'reviewer', outcome: 'completed', to: { node: 'finalGate' } }, { from: 'finalGate', outcome: 'passed', to: { end: 'completed' } },
      ...(repair ? [{ from: 'finalGate', outcome: 'rejected', to: { node: 'repairInput' }, limit: { max: repair.maxRounds, exhausted: { end: 'rejected' } } },
        { from: 'repairInput', outcome: 'completed', to: { node: 'repair' } }, { from: 'repair', outcome: 'completed', to: { node: 'finalGate' } }] : [{ from: 'finalGate', outcome: 'rejected', to: { end: 'rejected' } }])] };
  const compiled = compileWorkflow(definition, files);
  return { files, driver, runtime, compiled,
    async run(runId: string): Promise<MarkingRun> {
      if (runIds.has(runId)) throw new Error('DUPLICATE_MARKING_RUN'); runIds.add(runId);
      const input = await files.prepareInput(runId, source, 'scan-source'); originals.set(runId, files.inspect(input, runId).manifest);
      try {
        const run = { input, snapshot: await (() => { observe = history.observer(compiled); return runtime.start(compiled, runId, input).completion; })() }; completed.set(runId, structuredClone(run)); return run;
      } catch (error) { await files.release(input, runId); throw error; }
    },
    /** Only the private completed Run and actual passed Gate authorize handoff. */
    async exportMarked(runId: string, destination: string) {
      const run = completed.get(runId), last = run?.snapshot.lastAccepted?.result;
      if (run?.snapshot.status !== 'succeeded' || run.snapshot.outcome !== 'completed' || last?.status !== 'accepted') throw new Error('PASSED_MARKING_REQUIRED');
      const trusted = files.inspect(last.output, runId);
      if (trusted.released || trusted.receipt?.componentId !== 'final-gate' || trusted.receipt.outcome !== 'passed') throw new Error('PASSED_MARKING_REQUIRED');
      // materialize() revalidates the private snapshot, then returns an isolated copy.
      // The caller selects a fresh staging directory and retains its evidence.
      await files.materialize(last.output, runId, destination);
      return { bundle: destination, candidateHash: trusted.manifest.files.find(f => f.path === 'candidate/marking-candidate.json')!.sha256 };
    },
    async release(run: MarkingRun) {
      for (const step of [...run.snapshot.steps].reverse()) {
        if (step.result.status === 'accepted') await files.release(step.result.output, run.snapshot.runId);
        else await files.cleanup(step.result.identity);
      }
      await files.release(run.input, run.snapshot.runId); originals.delete(run.snapshot.runId); completed.delete(run.snapshot.runId);
    },
  };
}

/** Copy the two declared report inputs; keep marking receipts in the staging bundle. */
export async function prepareMarkedReportSource(markedBundle: string, destination: string) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const tree of ['source', 'candidate']) await cp(join(markedBundle, tree), join(destination, tree), { recursive: true, force: false, errorOnExist: true });
}
