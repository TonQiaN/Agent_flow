import { mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime, snapshotJson } from '@agentflow/engine';
import { SqliteRunRecordStore } from '@agentflow/integrations';
import { recruitmentDefinition } from '../../examples/recruitment/flow.js';
import { seedArtifactRun } from './studio-artifacts.js';

export const visualRun = 'run-visual-recruitment';
export const visualCode = 'run-visual-code';
export const visualTime = Date.parse('2026-09-17T02:00:00Z');
/** Deterministic display fixtures, not model acceptance. Actual engine, SQLite history and artifact readers. */
export async function seedVisualRuns(directory: string) {
  const dataRoot = resolve(directory);
  if (basename(dataRoot) !== 'studio-visual-tests') throw new Error('Visual fixtures require their own studio-visual-tests directory');
  await rm(join(dataRoot, 'runs'), { recursive: true, force: true });
  const realNow = Date.now;
  let tick = visualTime;
  Date.now = () => tick += 1000;
  try {
    await seedArtifactRun(dataRoot, visualCode);
    const root = join(dataRoot, 'runs', visualRun);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const records = await SqliteRunRecordStore.open(join(root, 'records'));
    try {
      const contracts = new ContractRegistry(); contracts.register('state', { type: 'object' });
      const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
      const candidates = ['陈晨（合成）', '林晓（合成）', '周宁（合成）'].map((name, i) => ({ id: `c${i + 1}`, name }));
      const result = { job: { title: 'TypeScript 全栈工程师' }, candidates,
        requirements: [{ id: 'R1', label: '能使用 TypeScript 和 React 开发可维护的页面' }],
        documents: [{ id: 'd1', name: 'resume-a.md' }],
        recommendations: candidates.map((candidate, i) => ({ candidateId: candidate.id, recommendation: i === 0 ? '推荐通过' : '推荐不通过',
          rationale: i === 0 ? '材料包含 TypeScript、React 和自动化测试的直接证据，符合岗位的必要条件。' : '关键要求缺少可核实的支持材料，当前证据不足以通过。',
          criteria: [{ requirementId: 'R1', state: i === 0 ? '支持' : '未证实', reason: '按岗位要求逐项核对原始材料。', evidence: i ? [] : [{ documentId: 'd1', page: 1, quote: '使用 TypeScript 和 React 开发工作流画布，支持节点拖动、详情与回放。' }] }],
          questions: ['请介绍你负责的模块，以及如何验证交付质量。'] })) };
      for (const node of ['parse', 'match', 'audit', 'render']) {
        components.register({ id: node, implementation: node, kind: 'transform', inputContract: 'state', outcomes: node === 'audit' ? { passed: 'state', revise: 'state', rejected: 'state' } : { completed: 'state' } });
        functions.registerDeterministic(node, { revision: 'visual-fixture-v1', run: () => ({ outcome: node === 'audit' ? 'passed' : 'completed', output: result }) });
      }
      const compiled = compileWorkflow(recruitmentDefinition, new JsonFunctionWorkflowCatalog(contracts, components, functions));
      await writeFile(join(root, 'meta.json'), JSON.stringify({ id: visualRun, mainRunId: visualRun, workflowId: 'recruitment', title: '一个岗位 · 三份合成简历', createdAt: Date.now(), uploads: [], fixture: true }));
      await (await new WorkflowRuntime().startPersisted(compiled, visualRun, { job: result.job, candidates }, records)).completion;
      await records.appendEvent(visualRun, snapshotJson({ kind: 'log', channel: 'stdout', text: '已完成逐项证据核对。' }));
      await writeFile(join(root, 'completion.json'), JSON.stringify({ finishedAt: Date.now(), error: null }));
    } finally { records.close(); }
  } finally { Date.now = realNow; }
}
