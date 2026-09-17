import { matchPrompt, auditPrompt } from '../recruitment/prompts.js';
import { tutorMarkingPrompts } from '../tutor-marking/prompts.js';
import { gradingFixturePrompts } from '../tutor-grading/fixture.js';
import { recruitmentScripts, recruitmentScriptResources } from '../recruitment/flow.js';

// Shared by the launcher and read-only catalogue so the displayed task is the installed task.
export const gradingInstructions = `Read source/paper.json, source/key.json and source/submission.json. Grade each question by ID. Copy source unchanged into outputs/source. Write outputs/candidate.json exactly as {paperId,studentId,revision,answers:[{questionId,score,evidence:{page,answer}}],total,maxTotal}. Use per-question maxScore for a correct answer, zero otherwise. Every question must occur once. Read gate-report.json when provided, fix all issues and increment revision. Do not write any other files. Do not invent a host gate decision.`;
export const persistentScriptResources = { image: 'node:22-bookworm-slim', network: 'none' as const };

export interface TaskNote {
  summary: string;
  input: string;
  output: string;
  mode: 'agent' | 'script' | 'host' | 'parallel' | 'fixture';
  prompt?: string;
  command?: string[];
  container?: { image: string; network: string; cpus?: number; memoryMiB?: number };
  source?: string;
  deferred?: string;
}
const note = (summary: string, input: string, output: string, mode: TaskNote['mode'], extra: Partial<TaskNote> = {}): TaskNote => ({ summary, input, output, mode, ...extra });
const prompts = tutorMarkingPrompts({ syntheticMaterial: false });
const grading = {
  intake: note('接收材料，保留原件供后续检查。', '试卷、答案、学生提交 JSON。', '未改写的材料副本。', 'host'),
  marker: note('按题目逐项批改，保留答题证据。', '试卷、答案和学生提交。', '逐题分数、证据和批改结果文件。', 'agent', { prompt: gradingInstructions }),
  gate: note('检查题目、分数、证据和材料是否一致。', '批改结果及原始材料。', '通过、返工或拒绝的检查结果。', 'host'),
  fixer: note('根据检查结果修订批改结果。', '原始材料、批改结果和检查意见。', '修订后的完整批改结果。', 'agent', { prompt: gradingInstructions }),
  projection: note('提取已经检查通过的发布内容。', '通过检查的批改结果。', '用于本机模拟发布的 JSON。', 'host'),
  publish: note('将结果交给本机模拟发布服务。', '经过检查的发布内容。', '发布回执。', 'host'),
};

export function taskNotes(workflow: string): Record<string, TaskNote> {
  const scriptNote = (id: 'parse' | 'render') => ({ source: 'src/examples/recruitment/documents.py', command: recruitmentScripts[id].argv,
    container: { ...recruitmentScriptResources, image: process.env['AGENTFLOW_DOCUMENTS_IMAGE'] ?? 'agentflow/studio-documents:issue39' } });
  if (workflow === 'recruitment') return {
    parse: note('读取岗位和所有简历，提取文字与原文页码；扫描件使用 OCR。', '一个岗位、多份简历及材料归属；文件在 /task/input/documents。', '带 documentId、页码和正文的材料；写入 /task/outputs/result.json。', 'script', scriptNote('parse')),
    match: note('一次完成整批匹配，逐项引用证据，给出二元推荐。', '解析后的岗位、所有候选人材料；返工时还包含复核意见。', '统一岗位要求、每人的逐项证据、推荐通过或推荐不通过、面试问题。', 'agent', { prompt: matchPrompt }),
    audit: note('独立核对原文、归属、遗漏和推荐结论；有错误则交回修订。', '原始岗位和简历、匹配分析及程序发现的问题。', '每人的复核结果；宿主校验后选择通过、返工或拒绝。', 'agent', { prompt: auditPrompt }),
    render: note('将已经复核的结果生成个人报告、候选人对照表和 PDF。', '检查通过的要求、逐项结论、二元推荐和复核结果。', 'reports 下的 Markdown、HTML、PDF、对照表和结果 JSON。', 'script', scriptNote('render')),
  };
  if (workflow === 'grading-real' || workflow === 'grading-fixture') {
    const result = structuredClone(grading);
    if (workflow === 'grading-fixture') for (const id of ['marker', 'fixer'] as const) { result[id].prompt = gradingFixturePrompts[id]; result[id].mode = 'fixture'; }
    return result;
  }
  if (workflow === 'grading-persistent') return {
    ...grading,
    intake: { ...grading.intake, mode: 'script', container: persistentScriptResources, source: 'src/examples/tutor-grading/file-scripts.ts', deferred: '脚本在上传后按本次材料生成；完整命令保存在运行记录中。' },
    gate: { ...grading.gate, mode: 'script', container: persistentScriptResources, source: 'src/examples/tutor-grading/file-scripts.ts', deferred: '命令包含本次原件摘要和发布目标，上传后生成并保存。' },
  };
  if (workflow === 'tutor-marking') return {
    intake: note('接收扫描试卷并保存原始材料。', '试卷、答题材料及扫描图片。', '供批改使用的原始材料包。', 'host'),
    marker: note('根据试卷和原始作答生成逐题批改材料。', '原始试卷与作答。', '批改候选文件和证据。', 'agent', { prompt: prompts.markerPrompt }),
    candidateGate: note('检查批改文件的结构和证据。', '批改候选文件及原始材料。', '通过或拒绝的检查记录。', 'host'),
    reviewer: note('独立复核批改结果和原始证据。', '已通过格式检查的批改结果。', '复核意见。', 'agent', { prompt: prompts.reviewerPrompt }),
    finalGate: note('检查复核结果，确定交付或返工。', '批改材料和复核意见。', '通过、返工或拒绝。', 'host'),
    repairInput: note('准备返工所需的材料和检查意见。', '检查未通过的材料及原因。', '返工材料包。', 'host'),
    repair: note('根据复核意见修订材料。', '原文、批改结果和返工意见。', '修订后的批改材料。', 'agent', { prompt: prompts.reviewerPrompt }),
  };
  if (workflow === 'tutor-report') return {
    prepare: note('整理已批改材料，生成报告输入。', '批改结果、证据及报告信息。', '报告素材包。', 'host'),
    reporter: note('根据批改结果生成学习报告。', '报告素材和报告信息。', '报告候选 JSON。', 'agent', { prompt: prompts.reporterPrompt }),
    gate: note('检查报告结构和内容是否符合要求。', '报告候选及原始材料。', '检查结果。', 'host'),
    render: note('调用本机 Tutor 工具生成 PDF。', '通过检查的报告。', '报告 PDF 和文件清单。', 'host'),
  };
  if (workflow.startsWith('parallel-')) return { batch: note('分派子任务，等待完成后汇总结果。', workflow.endsWith('map') ? '待处理项目列表。' : '分支共享的输入。', '按定义顺序汇总的子任务结果。', 'parallel') };
  if (workflow === 'repair-example') return {
    review: note('检查草稿版本是否达到 2。', '含 revision 的草稿。', '接受或返工，保留草稿。', 'host'),
    repair: note('将草稿版本增加 1。', '需要返工的草稿。', '更新版本后的草稿。', 'host'),
  };
  return {};
}
