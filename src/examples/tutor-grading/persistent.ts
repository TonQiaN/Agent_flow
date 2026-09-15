import { join } from 'node:path';
import { isIdentifier } from '@agentflow/domain';
import { AgentExecutor, ComponentRegistry, EffectExecutor, EffectWorkflowCatalog, WorkflowRuntime, compileWorkflow, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import type { AgentExecutionDriver, ArtifactStore, RunRecordStore, EffectAdapter, EffectRecordStore, EffectRequest, EffectApproval, ScriptExecutor, WorkflowCatalog } from '@agentflow/engine';
import { FileArtifactArchive, FileArtifactStore, FileWorkflowCatalog, FileJsonWorkflowCatalog } from '@agentflow/integrations';
import { gradingContracts } from './contracts.js';
import { gradingComponent, gradingWorkflow } from './flow.js';
import type { GradingAgentBinding, GradingRouteOptions } from './flow.js';
import { gradingFileScripts } from './file-scripts.js';
import { prepareGradingSource, readGradingSource } from './source.js';

export interface PersistentGradingSetup<D extends AgentExecutionDriver> {
  readonly records: RunRecordStore;
  /** Only new Runs receive a source directory, whose root contains source/*.json. */
  readonly source?: string;
  readonly driver: (artifacts: ArtifactStore) => D;
  readonly scripts: ScriptExecutor;
  readonly agents: readonly GradingAgentBinding[];
  readonly route: GradingRouteOptions;
  readonly publication: {
    readonly target: string; readonly key: string;
    readonly adapter: EffectAdapter; readonly journal: EffectRecordStore;
    /** Current host policy. Never saved or restored from a checkpoint. */
    readonly allowApply: () => boolean;
  };
}

/** Explicit composition root. Scoring, execution, storage and publication remain separate. */
export async function createPersistentGradingApplication<D extends AgentExecutionDriver>(root: string, runId: string, setup: PersistentGradingSetup<D>) {
  if (!isIdentifier(runId)) throw new Error('INVALID_GRADING_RUN');
  const route = structuredClone(setup.route), bindings = structuredClone(setup.agents), records = setup.records;
  const { target, key, adapter, journal, allowApply } = setup.publication;
  if (!/^[a-z0-9-]+$/.test(target) || !isIdentifier(key) || typeof allowApply !== 'function') throw new Error('INVALID_GRADING_PUBLICATION');
  const owners = new Map<string, WorkflowCatalog>(), agentIds = new Set<string>(), reserved = new Set(['intake', 'grading-gate', 'publication-input', 'publish']);
  for (const b of bindings) {
    if (reserved.has(b.component.id) || agentIds.has(b.component.id) || b.component.kind !== 'agent') throw new Error('INVALID_GRADING_AGENT_BINDING');
    agentIds.add(b.component.id);
  }
  if (!agentIds.has(route.marker) || !agentIds.has(route.fixer)) throw new Error('INVALID_GRADING_AGENT_ROUTE');
  const contracts = gradingContracts(), artifacts = new FileArtifactStore(join(root, 'temporary'), contracts.files);
  const archive = new FileArtifactArchive(join(root, 'archive'), contracts.files);
  const files = new FileWorkflowCatalog(contracts.files, artifacts, join(root, 'nodes'), archive);
  const bridge = new FileJsonWorkflowCatalog(files, contracts.json, join(root, 'transforms'));
  const driver = setup.driver(artifacts), agents = new AgentExecutor(contracts.files, artifacts, driver), scriptExecutor = setup.scripts;
  const runtime = new WorkflowRuntime(), prepared = setup.source === undefined ? null : await prepareGradingSource(files, runId, setup.source);
  try {
    const original = prepared?.source ?? await readGradingSource(runId, records, archive);
    const scripts = await gradingFileScripts(original, { workoutId: target });
    files.registerScript(gradingComponent('intake', 'transform', 'source-files', { completed: 'source-files' }), scriptExecutor, scripts.intake); owners.set('intake', files);
    for (const binding of bindings) { files.registerAgent(binding.component, agents, { prompt: binding.prompt, config: binding.config }); owners.set(binding.component.id, files); }
    files.registerScript(gradingComponent('grading-gate', 'gate', 'candidate-files', { passed: 'publishable-files', revise: 'reviewed-files', rejected: 'reviewed-files' }), scriptExecutor, scripts.gate); owners.set('grading-gate', files);
    bridge.registerJsonFile(gradingComponent('publication-input', 'transform', 'publishable-files', { completed: 'publication-json' }), { path: 'publication.json', outcome: 'completed' }); owners.set('publication-input', bridge);
    const components = new ComponentRegistry(contracts.json);
    components.register(gradingComponent('publish', 'effect', 'publication-json', { applied: 'effect-receipt', 'already-applied': 'effect-receipt', simulated: 'effect-receipt' }));
    const effects = new EffectExecutor(contracts.json, components, adapter, journal);
    const approve = (request: EffectRequest): EffectApproval | undefined => {
      if (!allowApply() || request.mode !== 'apply' || request.target !== target || request.key !== key || request.componentId !== 'publish' || request.identity.runId !== runId) return;
      const current = runtime.query(runId), last = current.lastAccepted?.result;
      if (current.currentNode !== 'publish' || JSON.stringify(current.currentIdentity) !== JSON.stringify(request.identity)
        || !last || last.status !== 'accepted' || last.componentId !== 'publication-input' || !bridge.matches(last.identity, request.input)) return;
      const converted = bridge.receipt(last.identity), passed = files.inspect(converted.predecessor, runId);
      if (passed.released || passed.receipt?.componentId !== 'grading-gate' || passed.receipt.outcome !== 'passed') return;
      const marked = files.inspect(passed.receipt.predecessor, runId);
      if (marked.released || !marked.receipt?.agent || !agentIds.has(marked.receipt.componentId)) return;
      return effects.authorize(request);
    };
    const publishing = new EffectWorkflowCatalog(contracts.json, components, effects);
    publishing.register('publish', { mode: 'apply', operation: { target, key }, approval: approve }); owners.set('publish', publishing);
    const catalog: WorkflowCatalog = { resolve(id) { const owner = owners.get(id); if (!owner) throw new Error('UNKNOWN_GRADING_COMPONENT'); return owner.resolve(id); } };
    const compiled = compileWorkflow(gradingWorkflow(route), catalog);
    return { compiled, runtime, files, bridge, driver, archive, catalog, approve, input: prepared?.input ?? null,
      async start() {
        if (!prepared) throw new Error('GRADING_SOURCE_REQUIRED');
        return runtime.startPersisted(compiled, runId, prepared.input, records);
      },
      load: () => loadWorkflowCheckpoint(compiled, runId, records),
      async resume() {
        const recovery = await claimWorkflowRecovery(compiled, runId, records);
        try { await recovery.cleanup(); return await runtime.resumePersisted(recovery); }
        catch (error) { await recovery.dispose(); throw error; }
      },
    };
  } catch (error) { if (prepared) await files.release(prepared.input, runId); throw error; }
}
