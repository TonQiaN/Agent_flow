import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue, ComponentDefinition } from '@agentflow/domain';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, ParallelWorkflowCatalog, compileWorkflow, ScriptExecutor, snapshotJson } from '@agentflow/engine';
import type { AgentExecutionDriver, WorkflowDefinition, ArtifactStore } from '@agentflow/engine';
import { DockerBackend, FileScriptRecordReader, JsonTaskWorkflowCatalog, systemClock } from '@agentflow/integrations';
import type { SqliteRunRecordStore } from '@agentflow/integrations';
import { dimensions, validateInput, validateRequirements, evidenceErrors, criterionErrors, recommendationErrors, bindReviewIdentity } from './contracts.js';
import type { RecruitmentState, Requirement, Review, Recommendation } from './contracts.js';
import { requirementsPrompt, reviewPrompt, auditPrompt, decisionPrompt } from './prompts.js';

export const recruitmentDefinition: WorkflowDefinition = {
  id: 'recruitment', start: 'parse', input: { kind: 'json', id: 'state' }, outcomes: { completed: { kind: 'json', id: 'state' }, rejected: { kind: 'json', id: 'state' } }, maxSteps: 45,
  nodes: Object.fromEntries(['parse', 'requirements', 'prepare-reviews', 'reviews', 'collect-reviews', 'prepare-audits', 'audits', 'collect-audits', 'evidence-gate', 'prepare-decisions', 'decisions', 'collect-decisions', 'delivery-gate', 'render'].map(id => [id, { component: id }])),
  routes: [
    ...[['parse', 'requirements'], ['requirements', 'prepare-reviews'], ['prepare-reviews', 'reviews'], ['reviews', 'collect-reviews'], ['collect-reviews', 'prepare-audits'], ['prepare-audits', 'audits'], ['audits', 'collect-audits'], ['collect-audits', 'evidence-gate'], ['prepare-decisions', 'decisions'], ['decisions', 'collect-decisions'], ['collect-decisions', 'delivery-gate']].map(([from, to]) => ({ from: from!, outcome: 'completed', to: { node: to! } })),
    { from: 'evidence-gate', outcome: 'passed', to: { node: 'prepare-decisions' } },
    { from: 'evidence-gate', outcome: 'revise', to: { node: 'prepare-reviews' }, limit: { max: 2, exhausted: { end: 'rejected' } } },
    { from: 'evidence-gate', outcome: 'revise-job', to: { node: 'requirements' }, limit: { max: 2, exhausted: { end: 'rejected' } } },
    { from: 'evidence-gate', outcome: 'rejected', to: { end: 'rejected' } },
    { from: 'delivery-gate', outcome: 'passed', to: { node: 'render' } },
    { from: 'delivery-gate', outcome: 'revise', to: { node: 'prepare-decisions' }, limit: { max: 2, exhausted: { end: 'rejected' } } },
    { from: 'render', outcome: 'completed', to: { end: 'completed' } },
  ],
};
interface Task { id: string; candidateId: string; dimension?: string; round: number; payload: Record<string, unknown>; context?: RecruitmentState; result?: unknown }
const asState = (value: JsonValue) => value as unknown as RecruitmentState;
const asTask = (value: JsonValue) => value as unknown as Task;
const jsonValue = (value: unknown): JsonValue => snapshotJson(value);
const component = (id: string, kind: ComponentDefinition['kind'], inputContract = 'state', output = 'state', outcomes = ['completed']): ComponentDefinition => ({ id, implementation: id, kind, inputContract, outcomes: Object.fromEntries(outcomes.map(o => [o, output])) });
const personPayload = (state: RecruitmentState, candidateId: string) => ({ candidateId, job: state.job, requirements: state.requirements, documents: state.documents.filter(d => d.owner === 'job' || d.owner === candidateId), repairReasons: state.repairReasons ?? [] });
const targets = (state: RecruitmentState) => state.candidates.filter(c => !state.repairCandidates?.length || state.repairCandidates.includes(c.id));
function tasks(state: RecruitmentState, stage: 'review' | 'audit' | 'decision'): Task[] {
  const all: Task[] = targets(state).flatMap(c => (stage === 'review' ? dimensions : [undefined]).map(dimension => ({ id: c.id + (dimension ? '-' + dimensions.indexOf(dimension) : ''), candidateId: c.id, ...(dimension ? { dimension } : {}), round: state.round ?? 0,
    payload: { ...personPayload(state, c.id), stage, ...(dimension ? { dimension } : {}), scenario: state.scenario ?? 'normal', round: state.round ?? 0, reviews: (state.reviews ?? []).filter(r => r.candidateId === c.id), audits: (state.audits ?? []).filter(a => a.candidateId === c.id) } })));
  all[0] = { ...all[0]!, context: state }; return all;
}
function joined(input: JsonValue): { state: RecruitmentState; tasks: Task[] } {
  const entries = (input as unknown as { items: { output?: Task }[] }).items;
  if (!entries?.length || entries.some(e => !e.output)) throw new Error('INCOMPLETE_CANDIDATE_BATCH');
  const complete = entries.map(e => e.output!); const state = complete.find(t => t.context)?.context;
  if (!state) throw new Error('MISSING_BATCH_CONTEXT'); return { state, tasks: complete };
}
export async function createRecruitmentFlow(root: string, documentsRoot: string, records: SqliteRunRecordStore, driver: (artifacts: ArtifactStore) => AgentExecutionDriver, config: JsonValue, image: string, testScenarios = false) {
  const contracts = new ContractRegistry(); contracts.register('state', { type: 'object' }); contracts.register('tasks', { type: 'array', minItems: 1, maxItems: 62 }); contracts.register('task', { type: 'object' }); contracts.register('joined', { type: 'object', required: ['items'], properties: { items: { type: 'array' } } });
  const components = new ComponentRegistry(contracts), functions = new FunctionRegistry(), host = new JsonFunctionWorkflowCatalog(contracts, components, functions);
  const files = new JsonTaskWorkflowCatalog(contracts, join(root, 'tasks'), async (identity, data) => { await records.appendEvent(identity.runId, jsonValue({ identity, ...data as object })); });
  const model = driver(files.artifacts), script = new ScriptExecutor(new DockerBackend({ workspaceRoot: join(root, 'scripts'), image, network: 'none', cpus: 1, memoryMiB: 1024 }), systemClock, new FileScriptRecordReader());
  const fn = (id: string, input: string, output: string, run: (v: JsonValue) => { outcome: string; output: JsonValue }, outcomes = ['completed']) => {
    components.register(component(id, id.includes('gate') ? 'gate' : 'transform', input, output, outcomes));
    functions.registerDeterministic(id, { revision: 'recruitment-v1', run: input => run(input) }, { version: 1 });
  };
  files.registerScript(component('parse', 'transform'), script, { argv: ['python3', '/opt/agentflow/documents.py'], timeoutMs: 600000 }, { revision: 'documents-v1',
    input: input => { validateInput(input); return jsonValue({ documents: asState(input).documents }); },
    prepare: async (input, destination) => { await mkdir(join(destination, 'documents')); for (const document of asState(input).documents) await cp(join(documentsRoot, document.storedName), join(destination, 'documents', document.storedName), { errorOnExist: true, force: false }); },
    output: (input, output) => jsonValue({ ...asState(input), documents: (output as unknown as { documents: unknown }).documents }),
  });
  files.registerAgent(component('requirements', 'agent'), model, { prompt: requirementsPrompt, config }, { revision: 'requirements-v1',
    input: input => jsonValue({ stage: 'requirements', job: asState(input).job, documents: asState(input).documents.filter(d => d.owner === 'job'), repairReasons: asState(input).repairReasons ?? [], scenario: asState(input).scenario ?? 'normal', round: asState(input).round ?? 0 }),
    output: (input, output) => { const requirements = (output as unknown as { requirements: Requirement[] }).requirements; validateRequirements(requirements); return jsonValue({ ...asState(input), requirements, reviews: [], audits: [], repairCandidates: [], round: asState(input).round ?? 0 }); },
  });
  for (const [id, prompt] of [['review-unit', reviewPrompt], ['audit-unit', auditPrompt], ['decision-unit', decisionPrompt]]) {
    files.registerAgent(component(id!, 'agent', 'task', 'task'), model, { prompt: prompt!, config }, { revision: id + '-v1', input: value => jsonValue(asTask(value).payload),
      output: (input, output) => { const task = asTask(input); return jsonValue({ id: task.id, candidateId: task.candidateId, round: task.round, ...(task.dimension ? { dimension: task.dimension } : {}), ...(task.context ? { context: task.context } : {}), result: output }); },
      fault: (input, identity) => testScenarios && id === 'review-unit' && asTask(input).candidateId === 'c1' && asTask(input).dimension === dimensions[0] && (asTask(input).payload.scenario === 'failure' || asTask(input).payload.scenario === 'retry' && identity.attemptNumber === 1),
    });
  }
  fn('prepare-reviews', 'state', 'tasks', input => ({ outcome: 'completed', output: jsonValue(tasks(asState(input), 'review')) }));
  fn('collect-reviews', 'joined', 'state', input => { const { state, tasks } = joined(input), updated = new Set(tasks.map(t => t.candidateId)); return { outcome: 'completed', output: jsonValue({ ...state, reviews: [...(state.reviews ?? []).filter(r => !updated.has(r.candidateId)), ...tasks.map(t => ({ ...bindReviewIdentity(t.result, t.candidateId, t.dimension), round: t.round }))] }) }; });
  fn('prepare-audits', 'state', 'tasks', input => ({ outcome: 'completed', output: jsonValue(tasks(asState(input), 'audit')) }));
  fn('collect-audits', 'joined', 'state', input => { const { state, tasks } = joined(input), updated = new Set(tasks.map(t => t.candidateId)); return { outcome: 'completed', output: jsonValue({ ...state, audits: [...(state.audits ?? []).filter(a => !updated.has(a.candidateId)), ...tasks.map(t => bindReviewIdentity(t.result, t.candidateId))] }) }; });
  fn('evidence-gate', 'state', 'state', input => {
    const state = asState(input), jobIssues = state.requirements!.flatMap(r => evidenceErrors(r.evidence, state.documents, 'job')), reasons: string[] = [...jobIssues];
    const repairCandidates = state.candidates.filter(c => {
      const reviews = state.reviews!.filter(r => r.candidateId === c.id), audit = state.audits?.find(a => a.candidateId === c.id);
      const errors = reviews.flatMap(r => criterionErrors(r.criteria, state, c.id, true));
      if (reviews.length !== dimensions.length || new Set(reviews.map(r => r.dimension)).size !== dimensions.length || dimensions.some(d => !reviews.some(r => r.dimension === d))) errors.push('四维评审未完成');
      if (!audit || !Array.isArray(audit.issues)) errors.push('独立复核未完成'); else errors.push(...audit.issues.map(i => i.reason));
      reasons.push(...errors.map(e => c.id + ': ' + e)); return errors.length > 0;
    }).map(c => c.id);
    const failed = reasons.length > 0, round = state.round ?? 0;
    return { outcome: failed ? round >= 2 ? 'rejected' : jobIssues.length ? 'revise-job' : 'revise' : 'passed', output: jsonValue({ ...state, round: failed ? round + 1 : round, repairCandidates: failed ? jobIssues.length ? [] : repairCandidates : [], repairReasons: reasons }) };
  }, ['passed', 'revise', 'revise-job', 'rejected']);
  fn('prepare-decisions', 'state', 'tasks', input => ({ outcome: 'completed', output: jsonValue(tasks(asState(input), 'decision')) }));
  fn('collect-decisions', 'joined', 'state', input => { const { state, tasks } = joined(input), updated = new Set(tasks.map(t => t.candidateId)); return { outcome: 'completed', output: jsonValue({ ...state, recommendations: [...(state.recommendations ?? []).filter(r => !updated.has(r.candidateId)), ...tasks.map(t => bindReviewIdentity(t.result, t.candidateId))] }) }; });
  fn('delivery-gate', 'state', 'state', input => {
    const state = asState(input), errors: string[] = [], repairCandidates: string[] = [];
    for (const c of state.candidates) { const rows = state.recommendations?.filter(r => r.candidateId === c.id) ?? [], invalid = rows.length === 1 ? recommendationErrors(rows[0], state, c.id) : ['候选人结果缺失或重复']; if (invalid.length) { errors.push(...invalid.map(e => c.id + ': ' + e)); repairCandidates.push(c.id); } }
    return { outcome: errors.length ? 'revise' : 'passed', output: jsonValue({ ...state, repairCandidates, repairReasons: errors }) };
  }, ['passed', 'revise']);
  files.registerScript(component('render', 'transform'), script, { argv: ['python3', '/opt/agentflow/documents.py', 'render'], timeoutMs: 120000 }, { revision: 'report-v1' });
  const fileIds = new Set(['parse', 'requirements', 'review-unit', 'audit-unit', 'decision-unit', 'render']);
  const base = { resolve: (id: string) => fileIds.has(id) ? files.resolve(id) : host.resolve(id) };
  const parallel = new ParallelWorkflowCatalog(contracts, base);
  for (const [id, unit] of [['reviews', 'review-unit'], ['audits', 'audit-unit'], ['decisions', 'decision-unit']]) parallel.register(id!, { kind: 'map', component: unit!, itemId: 'id', inputContract: 'tasks', outputContract: 'joined', outcome: 'completed', maxConcurrency: 2, failurePolicy: 'wait-all', retry: { maxAttempts: 2, on: ['execution_failure', 'timeout'], delayMs: 1200 } });
  return { compiled: compileWorkflow(recruitmentDefinition, parallel), parallel, files };
}
