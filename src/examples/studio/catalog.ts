// @ts-expect-error Shared plain-JavaScript original CLI definition.
import { parallelDefinition } from './parallel.mjs';
import { recruitmentDefinition, createRecruitmentFlow } from '../recruitment/flow.js';
import { RecruitmentFixtureDriver } from '../recruitment/fixture-driver.js';
import {
  gradingDefinition,
  createGradingFixture,
} from '../tutor-grading/fixture.js';
import { gradingWorkflow, gradingComponent, createGradingApplication } from '../tutor-grading/flow.js';
import { selectGradingHarness, gradingHarness } from '../tutor-grading/selected-harness.js';
import { tutorMarkingPrompts } from '../tutor-marking/prompts.js';
import { createTutorMarkingApplication } from '../tutor-marking/application.js';
import { createTutorReportApplication } from '../tutor-report/application.js';
import { fixtureContext } from '../tutor-report/fixture-driver.js';
// @ts-expect-error Shared plain-JavaScript original CLI factory.
import { createRepairExample } from './repair.mjs';
import { compileWorkflow, inspectWorkflowExecution } from '@agentflow/engine';
import type { AgentExecutionDriver, ArtifactStore, WorkflowDisplayDefinition } from '@agentflow/engine';
import { SqliteRunRecordStore, projectExecution } from '@agentflow/integrations';
import { taskNotes, gradingInstructions } from './task-notes.js';
import type { TaskNote } from './task-notes.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function displayPaths(value: unknown, root: string): any {
  if (Array.isArray(value)) return value.map(item => displayPaths(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'workspaceRoot' && typeof item === 'string' && item.startsWith(root)
      ? '<启动运行后分配>' : displayPaths(item, root)]));
  return value;
}
export interface CatalogueItem {
  id: string;
  title: string;
  description: string;
  entrypoint: string;
  input: string;
  requires: string[];
  definition: unknown;
  category: 'business' | 'example';
  family: string;
  tasks: Record<string, TaskNote>;
  execution?: Partial<WorkflowDisplayDefinition>;
}
export async function catalogue(): Promise<CatalogueItem[]> {
  const base = [
    {
      id: 'recruitment',
      title: '简历与岗位匹配',
      description:
        '读取材料、匹配推荐、独立复核、生成报告。一个岗位，多份简历，逐项证据与二元推荐。',
      entrypoint: 'recruitment/run.ts',
      input: 'recruitment',
      requires: ['docker', 'documents', 'harness'],
      definition: recruitmentDefinition,
    },
    {
      id: 'repair-example',
      title: '检查与返工示例',
      description: '现有 JSON 示例：检查草稿，按路线返工，验证次数上限。',
      entrypoint: 'workflow.mjs',
      input: 'none',
      requires: [],
      definition: createRepairExample().definition,
    },
    ...['map', 'fork'].map((kind) => ({
      id: 'parallel-' + kind,
      title: kind === 'map' ? 'Map 并行处理' : 'Fork 分支汇合',
      description: '现有队列示例：多项任务同时执行，按规定顺序汇合。',
      entrypoint: 'json-parallel.mjs',
      input: 'none',
      requires: [],
      definition: parallelDefinition(kind),
    })),
    {
      id: 'grading-fixture',
      title: '批卷与返工示例',
      description:
        '现有固定响应示例：逐题批卷、关卡、修订和模拟发布，无模型费用。',
      entrypoint: 'tutor-grading/demo.ts',
      input: 'none',
      requires: [],
      definition: gradingDefinition(),
    },
    {
      id: 'grading-real',
      title: '试卷批改 · Agent',
      description: '上传试卷、答案与提交 JSON，复用原批卷关卡和模拟发布。',
      entrypoint: 'tutor-grading/grading.ts',
      input: 'grading',
      requires: ['docker', 'harness'],
      definition: gradingWorkflow({
        id: 'real-grading',
        marker: 'matrix-marker',
        fixer: 'matrix-fixer',
        repairs: 1,
      }),
    },
    {
      id: 'grading-persistent',
      title: '试卷批改 · 持久化',
      description:
        '复用文件脚本、持久化检查点和发布凭据链；发布到本次本机模拟服务。',
      entrypoint: 'tutor-grading/persistent.ts',
      input: 'grading',
      requires: ['docker', 'harness'],
      definition: gradingWorkflow({
        id: 'persistent-grading',
        marker: 'matrix-marker',
        fixer: 'matrix-fixer',
        repairs: 1,
      }),
    },
  ];
  const root = await mkdtemp(join(tmpdir(), 'af-catalogue-')),
    before = process.env['AGENTFLOW_HISTORY_DISABLED'];
  process.env['AGENTFLOW_HISTORY_DISABLED'] = '1';
  try {
    let selected: ReturnType<typeof selectGradingHarness> | undefined;
    try {
      selected = selectGradingHarness(gradingHarness(process.env['AGENTFLOW_STUDIO_HARNESS'] ?? 'deepseek'),
        { ...process.env, AGENTFLOW_ACCEPTANCE_ROOT: root }, { timeoutMs: 600000, maxInputBytes: 144 * 1024 ** 2, persistSession: true });
    } catch { /* Tasks remain readable before local model configuration is ready. */ }
    const missingDriver: AgentExecutionDriver = {
      harness: 'unconfigured', validate() {},
      async run() { throw new Error('CATALOGUE_CANNOT_EXECUTE'); },
    };
    const driver = (store: ArtifactStore) => selected?.driver(store, root) ?? missingDriver;
    const prompts = tutorMarkingPrompts({ syntheticMaterial: false });
    const agent = (id: string, prompt: string) => ({ id, prompt, config: selected?.config ?? {} });
    const execution: Record<string, Partial<WorkflowDisplayDefinition>> = {},
      setup = {
        source: join(root, 'source'),
        tutorWorkspace: process.env['TUTOR_WORKSPACE'] ?? '/unconfigured/tutor',
        python: process.env['TUTOR_PYTHON'] ?? '/usr/bin/python3',
        driver,
      };
    const marking = await createTutorMarkingApplication(join(root, 'marking'), {
      ...setup,
      marker: agent('marker', prompts.markerPrompt),
      reviewer: agent('reviewer', prompts.reviewerPrompt),
      repair: { agent: agent('reviewer-repair', prompts.reviewerPrompt), maxRounds: 2 },
    });
    const report = await createTutorReportApplication(join(root, 'report'), {
      ...setup,
      context: fixtureContext,
      reporter: agent('model', prompts.reporterPrompt),
    });
    execution['tutor-marking'] = await inspectWorkflowExecution(marking.compiled);
    execution['tutor-report'] = await inspectWorkflowExecution(report.compiled);
    execution['repair-example'] = await inspectWorkflowExecution(createRepairExample());
    const fixtureApp = await createGradingFixture(join(root, 'grading-fixture'));
    execution['grading-fixture'] = await inspectWorkflowExecution(compileWorkflow(gradingDefinition(), fixtureApp.catalog));
    await mkdir(setup.source, { recursive: true });
    const gradingAgents = ['matrix-marker', 'matrix-fixer'].map((id, index) => ({
      component: gradingComponent(id, 'agent', index ? 'reviewed-files' : 'source-files', { completed: 'candidate-files' }),
      prompt: gradingInstructions, config: selected?.config ?? {},
    }));
    const realDefinition = gradingWorkflow({ id: 'real-grading', marker: 'matrix-marker', fixer: 'matrix-fixer', repairs: 1 });
    const gradingApp = await createGradingApplication(join(root, 'grading-real'), { source: setup.source, driver, agents: gradingAgents, definition: realDefinition });
    execution['grading-real'] = await inspectWorkflowExecution(compileWorkflow(realDefinition, gradingApp.catalog));
    // Persistent scripts include uploaded source hashes: do not manufacture a sample Run to describe them.
    const pickAgents = <T>(values: Readonly<Record<string, T>> | undefined) => Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => ['marker', 'fixer'].includes(id)));
    execution['grading-persistent'] = {
      bindings: pickAgents(execution['grading-real'].bindings),
      resourcePlans: pickAgents(execution['grading-real'].resourcePlans),
      unavailable: { ...pickAgents(execution['grading-real'].unavailable), intake: 'GENERATED_AFTER_UPLOAD', gate: 'GENERATED_AFTER_UPLOAD' },
    };
    const records = await SqliteRunRecordStore.open(join(root, 'inspection-records'));
    try {
      const fixture = process.env['AGENTFLOW_STUDIO_FIXTURE'] === '1';
      const recruitmentSelected = selected && selectGradingHarness(gradingHarness(process.env['AGENTFLOW_STUDIO_HARNESS'] ?? 'deepseek'),
        { ...process.env, AGENTFLOW_ACCEPTANCE_ROOT: root }, { timeoutMs: 600000, maxInputBytes: 16 * 1024 ** 2, persistSession: true });
      const app = await createRecruitmentFlow(join(root, 'recruitment'), setup.source, records,
        store => fixture ? new RecruitmentFixtureDriver(store, join(root, 'fixture')) : recruitmentSelected?.driver(store, root) ?? missingDriver,
        fixture ? { fixture: true } : selected?.config ?? {}, process.env['AGENTFLOW_DOCUMENTS_IMAGE'] ?? 'agentflow/studio-documents:issue39', fixture);
      execution.recruitment = await inspectWorkflowExecution(app.compiled);
    } finally { records.close(); }
    base.push(
      {
        id: 'tutor-marking',
        title: '扫描试卷批改 · Tutor',
        description:
          '现有 Tutor 工作流：接收材料、批改、独立复核和返工。需安装 Tutor。',
        entrypoint: 'tutor-marking/application.ts',
        input: 'tutor-marking',
        requires: ['docker', 'harness', 'tutor'],
        definition: marking.compiled.definition,
      },
      {
        id: 'tutor-report',
        title: '学习报告 · Tutor',
        description: '现有报告流程：读取已批改材料、生成报告、验证并导出 PDF。',
        entrypoint: 'tutor-report/application.ts',
        input: 'tutor-report',
        requires: ['docker', 'harness', 'tutor'],
        definition: report.compiled.definition,
      },
    );
    return base.map((item) => ({
      ...item,
      tasks: taskNotes(item.id),
      ...(execution[item.id] ? { execution: displayPaths(projectExecution(execution[item.id]), root) } : {}),
      category: [
        'repair-example',
        'parallel-map',
        'parallel-fork',
        'grading-fixture',
      ].includes(item.id)
        ? ('example' as const)
        : ('business' as const),
      family:
        item.id === 'recruitment'
          ? 'recruitment'
          : item.id === 'tutor-report'
            ? 'report'
            : item.input === 'none'
              ? 'examples'
              : 'grading',
    }));
  } finally {
    if (before === undefined) delete process.env['AGENTFLOW_HISTORY_DISABLED'];
    else process.env['AGENTFLOW_HISTORY_DISABLED'] = before;
    await rm(root, { recursive: true, force: true });
  }
}
