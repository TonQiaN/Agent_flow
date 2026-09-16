// @ts-expect-error Shared plain-JavaScript original CLI definition.
import { parallelDefinition } from './parallel.mjs';
import { recruitmentDefinition } from '../recruitment/flow.js';
import {
  gradingDefinition,
  createGradingFixture,
} from '../tutor-grading/fixture.js';
import { gradingWorkflow } from '../tutor-grading/flow.js';
import { createTutorMarkingApplication } from '../tutor-marking/application.js';
import { createTutorReportApplication } from '../tutor-report/application.js';
import { GradingFixtureDriver } from '../tutor-grading/fixture-driver.js';
import { fixtureContext } from '../tutor-report/fixture-driver.js';
// @ts-expect-error Shared plain-JavaScript original CLI factory.
import { createRepairExample } from './repair.mjs';
import { inspectWorkflowExecution } from '@agentflow/engine';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const dummy = {
        id: 'model',
        prompt: 'Descriptor only; never executed.',
        config: { mode: 'correct' },
      },
      setup = {
        source: join(root, 'source'),
        tutorWorkspace: process.env['TUTOR_WORKSPACE'] ?? '/unconfigured/tutor',
        python: process.env['TUTOR_PYTHON'] ?? '/usr/bin/python3',
        driver: (store: any) =>
          new GradingFixtureDriver(store, join(root, 'unused')),
      };
    const marking = await createTutorMarkingApplication(join(root, 'marking'), {
      ...setup,
      marker: { ...dummy, id: 'marker' },
      reviewer: { ...dummy, id: 'reviewer' },
      repair: { agent: { ...dummy, id: 'reviewer-repair' }, maxRounds: 2 },
    });
    const report = await createTutorReportApplication(join(root, 'report'), {
      ...setup,
      context: fixtureContext,
      reporter: dummy,
    });
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
