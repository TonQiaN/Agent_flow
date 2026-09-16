import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutionDriver, ArtifactStore, FileManifest, HarnessTask, AgentExecutionFacts, Cancellation } from '@agentflow/engine';
import { snapshotJson } from '@agentflow/engine';
import type { ExecutionEventSink } from '@agentflow/integrations';
import type { Document, Requirement, Criterion } from './contracts.js';
export const fixtureCredential = { service: 'fixture', method: 'synthetic', credentialRef: 'recruitment' };
/** Explicit synthetic model replacement for reproducible CI; extraction, queue, files and PDF are real. */
export class RecruitmentFixtureDriver implements AgentExecutionDriver {
  readonly harness = 'recruitment-fixture';
  constructor(private readonly artifacts: ArtifactStore, private readonly root: string, private readonly token?: string, private readonly events?: ExecutionEventSink) {}
  validate(_task: HarnessTask) {}
  dispatchBinding() { return { harness: this.harness, credential: fixtureCredential, capacity: null, ...(this.token ? { admissionToken: this.token } : {}) }; }
  async definitionSnapshot(task: HarnessTask) { return snapshotJson({ schema: 'recruitment-fixture/v1', prompt: task.prompt, config: task.config, container: null, internalLogs: 'synthetic-events-only' }); }
  async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation) {
    const startedAt = Date.now(); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.root, 'fixture-'));
    await this.artifacts.materialize(input.id, join(root, 'input')); await mkdir(join(root, 'outputs'));
    const request = JSON.parse(await readFile(join(root, 'input/request.json'), 'utf8'));
    const docs = request.documents as Document[];
    const evidence = (document: Document, quote?: string) => ({ documentId: document.id, page: 1, quote: quote ?? document.pages![0]!.text });
    let result: unknown;
    if (request.stage === 'requirements') {
      const job = docs.find(d => d.kind === 'job')!, lines = job.pages![0]!.text.split('\n').filter(l => /^(必需|职责|加分)/.test(l));
      result = { requirements: lines.map((line, i) => ({ id: `R${i + 1}`, label: line, kind: line.slice(0, 2), evidence: [evidence(job, request.scenario === 'job-rework' && request.round === 0 && i === 0 ? '不存在的岗位证据' : line)] })) };
    } else {
      const person = docs.find(d => d.kind === 'resume')!, candidateId = request.candidateId, source = evidence(person);
      const criteria: Criterion[] = (request.requirements as Requirement[]).map((r, i) => ({ requirementId: r.id,
        state: candidateId === 'c1' ? '已支持' : candidateId === 'c3' ? i === 1 ? '材料冲突' : '未证实' : i === 0 ? '已支持' : '不支持',
        reason: candidateId === 'c1' || (candidateId !== 'c3' && i === 0) ? '材料包含对应实践。' : candidateId === 'c3' ? '材料缺失或摘要与项目细节冲突。' : '材料明确缺少对应实践。', evidence: [source] }));
      if (request.stage === 'review') {
        if (request.scenario === 'rework' && request.round === 0 && candidateId === 'c1') criteria[0]!.evidence = [{ ...source, page: 99 }];
        result = { criteria, notes: ['合成评审，仅用于验证展示与编排'] };
      } else if (request.stage === 'audit') result = { issues: [], summary: '合成独立复核完成；确定性关卡继续检查引用。' };
      else result = { candidateId, recommendation: candidateId === 'c1' ? '推荐通过' : '推荐不通过', rationale: candidateId === 'c1' ? '必需项均有材料支持。' : '关键岗位要求缺少可靠支持。', decisiveRequirementIds: ['R1', 'R2'], uncertaintyImpact: candidateId === 'c3' ? '缺失与冲突涉及必需项，因此推荐不通过。' : '', criteria, questions: ['请现场演示对应项目中的接口测试。'] };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(join(root, 'outputs/result.json'), JSON.stringify(result));
    const message = JSON.stringify({ type: 'fixture.completed', stage: request.stage, candidateId: request.candidateId ?? null });
    await writeFile(join(root, 'stdout'), message); await writeFile(join(root, 'stderr'), '');
    await this.events?.({ identity: task.identity, kind: 'fixture', data: snapshotJson({ stage: request.stage, summary: '合成响应；无模型内部过程' }), receivedAt: Date.now() });
    const facts: AgentExecutionFacts = { runner: { identity: task.identity, resource: { id: 'fixture-resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed', capture: { imageId: null, outputsPath: join(root, 'outputs'), files: {}, stdout: { path: join(root, 'stdout'), bytes: Buffer.byteLength(message), complete: true, truncated: false }, stderr: { path: join(root, 'stderr'), bytes: 0, complete: true, truncated: false } }, diagnostics: [], startedAt, finishedAt: Date.now() }, harness: { identity: task.identity, harness: this.harness, status: cancellation.requested() ? 'failed' : 'completed', outcome: null, events: [], diagnostics: [], usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }, version: '1.0.0', finalized: true, diagnostics: [] };
    return { facts, async retryCleanup() {}, release: () => rm(root, { recursive: true, force: true }) };
  }
}
