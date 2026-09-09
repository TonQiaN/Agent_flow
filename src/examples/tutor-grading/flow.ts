import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentDefinition, JsonValue } from '@agentflow/domain';
import { AgentExecutor, ComponentRegistry, EffectExecutor, EffectWorkflowCatalog, compileWorkflow, WorkflowRuntime } from '@agentflow/engine';
import type { EffectMode, FileManifest, WorkflowCatalog, WorkflowDefinition, WorkflowSnapshot, EffectRequest, EffectApproval } from '@agentflow/engine';
import { FileArtifactStore, FileWorkflowCatalog, FileJsonWorkflowCatalog, SimulatedEffectService } from '@agentflow/integrations';
import { gradingContracts } from './contracts.js';
import { GradingFixtureDriver, fixtureRoot } from './fixture-driver.js';
import type { FixtureMode } from './fixture-driver.js';
import { readJson, review, sourcePaths } from './gate.js';
import type { Candidate, GateReport } from './gate.js';

const component = (id: string, kind: ComponentDefinition['kind'], inputContract: string, outcomes: Record<string, string>): ComponentDefinition => ({ id, kind, implementation: `${id}-impl`, inputContract, outcomes });
export interface GradingOptions { readonly marker?: FixtureMode; readonly fixer?: 'correct' | 'stuck'; readonly repairs?: number; readonly maxSteps?: number; readonly mode?: EffectMode; readonly allowApply?: boolean }
export function gradingDefinition(options: GradingOptions = {}): WorkflowDefinition {
  return { id: 'fixture-grading', start: 'intake', input: { kind: 'files', id: 'source-files' }, maxSteps: options.maxSteps ?? 20,
    outcomes: { published: { kind: 'json', id: 'effect-receipt' }, rejected: { kind: 'files', id: 'reviewed-files' } },
    nodes: { intake: { component: 'intake' }, marker: { component: `marker-${options.marker ?? 'wrong'}` }, gate: { component: 'grading-gate' },
      fixer: { component: `fixer-${options.fixer ?? 'correct'}` }, projection: { component: 'publication-input' }, publish: { component: 'publish' } },
    routes: [{ from: 'intake', outcome: 'completed', to: { node: 'marker' } }, { from: 'marker', outcome: 'completed', to: { node: 'gate' } },
      { from: 'gate', outcome: 'passed', to: { node: 'projection' } }, { from: 'gate', outcome: 'rejected', to: { end: 'rejected' } },
      { from: 'gate', outcome: 'revise', to: { node: 'fixer' }, limit: { max: options.repairs ?? 1, exhausted: { end: 'rejected' } } },
      { from: 'fixer', outcome: 'completed', to: { node: 'gate' } }, { from: 'projection', outcome: 'completed', to: { node: 'publish' } },
      ...['simulated', 'applied', 'already-applied'].map(outcome => ({ from: 'publish', outcome, to: { end: 'published' } }))] };
}
export interface GradingRun { readonly input: JsonValue; readonly snapshot: WorkflowSnapshot }

/** Local acceptance application. All writes are to a private in-memory service. */
export async function createGradingFixture(root: string, options: GradingOptions = {}) {
  options = structuredClone(options);
  const contracts = gradingContracts(), store = new FileArtifactStore(join(root, 'artifacts'), contracts.files);
  const files = new FileWorkflowCatalog(contracts.files, store, join(root, 'nodes'));
  const bridge = new FileJsonWorkflowCatalog(files, contracts.json, join(root, 'transforms'));
  const driver = new GradingFixtureDriver(store, join(root, 'agents')), agents = new AgentExecutor(contracts.files, store, driver);
  const runtime = new WorkflowRuntime(), originals = new Map<string, FileManifest>(), runs = new Set<string>(), owners = new Map<string, WorkflowCatalog>();
  const source = join(root, 'original'); await mkdir(source, { recursive: true });
  await cp(join(fixtureRoot, 'source'), join(source, 'source'), { recursive: true, errorOnExist: true, force: false });
  files.registerFunction(component('intake', 'transform', 'source-files', { completed: 'source-files' }), async ctx => { await cp(ctx.inputPath, ctx.outputsPath, { recursive: true }); return { outcome: 'completed' }; }); owners.set('intake', files);
  for (const mode of ['correct', 'wrong', 'malformed', 'source-tamper', 'bad-evidence', 'stuck'] as const) {
    const id = `marker-${mode}`; files.registerAgent(component(id, 'agent', 'source-files', { completed: 'candidate-files' }), agents,
      { prompt: 'Grade the submitted answers against the supplied paper and answer key. Put candidate.json and the source bundle in outputs.', config: { mode } }); owners.set(id, files);
  }
  for (const mode of ['correct', 'stuck'] as const) {
    const id = `fixer-${mode}`; files.registerAgent(component(id, 'agent', 'reviewed-files', { completed: 'candidate-files' }), agents,
      { prompt: 'Read gate-report.json and repair the grading candidate. Put the corrected bundle in outputs.', config: { mode } }); owners.set(id, files);
  }
  files.registerFunction(component('grading-gate', 'gate', 'candidate-files', { passed: 'reviewed-files', revise: 'reviewed-files', rejected: 'reviewed-files' }), async ctx => {
    const original = originals.get(ctx.identity.runId); if (!original) throw new Error('UNKNOWN_GRADING_SOURCE'); return review(ctx, original);
  }); owners.set('grading-gate', files);
  bridge.register(component('publication-input', 'transform', 'reviewed-files', { completed: 'publication-json' }), async ctx => {
    const receipt = ctx.source.receipt;
    if (receipt?.componentId !== 'grading-gate' || receipt.outcome !== 'passed') throw new Error('GATE_RECEIPT_REQUIRED');
    const candidate = await readJson<Candidate>(ctx.inputPath, 'candidate.json'), report = await readJson<GateReport>(ctx.inputPath, 'gate-report.json');
    const hash = (path: string): string => { const file = ctx.source.manifest.files.find(f => f.path === path); if (!file) throw new Error('MISSING_FILE'); return file.sha256; };
    if (report.decision !== 'passed' || report.findings.length || report.candidateHash !== hash('candidate.json')) throw new Error('GATE_REPORT_MISMATCH');
    return { outcome: 'completed', output: { workoutId: 'fixture-workout', paperId: candidate.paperId, studentId: candidate.studentId, total: candidate.total,
      maxTotal: candidate.maxTotal, candidateHash: hash('candidate.json'), reportHash: hash('gate-report.json'), sourceFiles: sourcePaths.map(path => ({ path, sha256: hash(path) })) } };
  }); owners.set('publication-input', bridge);
  const service = new SimulatedEffectService('fixture-business-credential'), components = new ComponentRegistry(contracts.json);
  components.register(component('publish', 'effect', 'publication-json', { simulated: 'effect-receipt', applied: 'effect-receipt', 'already-applied': 'effect-receipt' }));
  const effects = new EffectExecutor(contracts.json, components, service.connect('publish-impl', 'fixture-publisher', 'fixture-business-credential'));
  const approve = (request: EffectRequest): EffectApproval | undefined => {
    if (!options.allowApply || request.mode !== 'apply' || request.target !== 'fixture-workout' || request.key !== 'fixture-publication' || request.componentId !== 'publish') return;
    const current = runtime.query(request.identity.runId), last = current.lastAccepted?.result;
    if (current.currentNode !== 'publish' || JSON.stringify(current.currentIdentity) !== JSON.stringify(request.identity)) return;
    if (!last || last.status !== 'accepted' || last.componentId !== 'publication-input' || !bridge.matches(last.identity, request.input)) return;
    const converted = bridge.receipt(last.identity), predecessor = files.inspect(converted.predecessor, request.identity.runId);
    if (predecessor.released || predecessor.receipt?.componentId !== 'grading-gate' || predecessor.receipt.outcome !== 'passed') return;
    return effects.authorize(request);
  };
  const effectCatalog = new EffectWorkflowCatalog(contracts.json, components, effects);
  effectCatalog.register('publish', { mode: options.mode ?? 'dry-run', operation: () => ({ target: 'fixture-workout', key: 'fixture-publication' }),
    ...(options.mode === 'apply' ? { approval: approve } : {}) }); owners.set('publish', effectCatalog);
  const catalog: WorkflowCatalog = { resolve(id) { const owner = owners.get(id); if (!owner) throw new Error('UNKNOWN_GRADING_COMPONENT'); return owner.resolve(id); } };
  return { source, files, bridge, driver, service, runtime, catalog, approve,
    async run(runId: string, definition = gradingDefinition(options)): Promise<GradingRun> {
      if (runs.has(runId)) throw new Error('DUPLICATE_GRADING_RUN'); runs.add(runId);
      const plan = compileWorkflow(definition, catalog), input = await files.prepareInput(runId, source, 'source-files');
      originals.set(runId, files.inspect(input, runId).manifest);
      try { return { input, snapshot: await runtime.start(plan, runId, input).completion }; }
      catch (error) { await files.release(input, runId); throw error; }
    },
    async release(run: GradingRun): Promise<void> {
      for (const step of run.snapshot.steps) {
        if (step.result.status === 'failed') { await files.cleanup(step.result.identity); await bridge.cleanup(step.result.identity); }
        else if (owners.get(step.result.componentId) === files) await files.release(step.result.output, run.snapshot.runId);
      }
      await files.release(run.input, run.snapshot.runId); originals.delete(run.snapshot.runId);
    },
  };
}
