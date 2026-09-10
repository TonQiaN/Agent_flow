import { createHash } from 'node:crypto';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileManifest } from '@agentflow/engine';
import type { FileFunctionContext } from '@agentflow/integrations';

export const sourcePaths = ['source/key.json', 'source/paper.json', 'source/submission.json'];
export interface Candidate { paperId: string; studentId: string; revision: number; answers: { questionId: string; score: number; evidence: { page: number; answer: number } }[]; total: number; maxTotal: number }
export interface GateReport { decision: 'passed' | 'revise' | 'rejected'; candidateHash: string; findings: string[] }
export const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const readJson = async <T>(root: string, path: string): Promise<T> => JSON.parse(await readFile(join(root, path), 'utf8')) as T;

/** Fixture-specific scoring rules live in the application, never in the engine. Input schemas were checked by the file contract. */
export async function review(context: FileFunctionContext, original: FileManifest): Promise<{ outcome: string }> {
  const findings: string[] = [];
  for (const path of sourcePaths) if (digest(await readFile(join(context.inputPath, path))) !== original.files.find(f => f.path === path)?.sha256) findings.push(`SOURCE_CHANGED:${path}`);
  const changedSource = findings.length > 0;
  const paper = await readJson<{ paperId: string; questions: { id: string; maxScore: number }[] }>(context.inputPath, 'source/paper.json');
  const key = await readJson<Record<string, number>>(context.inputPath, 'source/key.json');
  const submission = await readJson<{ studentId: string; answers: { questionId: string; answer: number; page: number }[] }>(context.inputPath, 'source/submission.json');
  const candidate = await readJson<Candidate>(context.inputPath, 'candidate.json');
  if (candidate.paperId !== paper.paperId || candidate.studentId !== submission.studentId) findings.push('IDENTITY_MISMATCH');
  const ids = paper.questions.map(q => q.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !Object.hasOwn(key, id)) || Object.keys(key).length !== ids.length
    || submission.answers.length !== ids.length || new Set(submission.answers.map(a => a.questionId)).size !== ids.length
    || submission.answers.some(a => !ids.includes(a.questionId))) findings.push('INVALID_SOURCE_COVERAGE');
  if (candidate.answers.length !== ids.length || new Set(candidate.answers.map(a => a.questionId)).size !== ids.length || candidate.answers.some(a => !ids.includes(a.questionId))) findings.push('CANDIDATE_COVERAGE');
  for (const question of paper.questions) {
    const answer = candidate.answers.find(a => a.questionId === question.id), source = submission.answers.find(a => a.questionId === question.id);
    if (!answer || !source) { findings.push(`MISSING_ANSWER:${question.id}`); continue; }
    if (answer.score !== (source.answer === key[question.id] ? question.maxScore : 0)) findings.push(`SCORE:${question.id}`);
    if (answer.evidence.page !== source.page || answer.evidence.answer !== source.answer) findings.push(`EVIDENCE:${question.id}`);
  }
  if (candidate.total !== candidate.answers.reduce((sum, a) => sum + a.score, 0) || candidate.maxTotal !== paper.questions.reduce((sum, q) => sum + q.maxScore, 0)) findings.push('TOTAL');
  const report: GateReport = { decision: changedSource || findings.includes('INVALID_SOURCE_COVERAGE') ? 'rejected' : findings.length ? 'revise' : 'passed',
    candidateHash: digest(await readFile(join(context.inputPath, 'candidate.json'))), findings };
  await cp(context.inputPath, context.outputsPath, { recursive: true });
  await writeFile(join(context.outputsPath, 'gate-report.json'), JSON.stringify(report));
  return { outcome: report.decision };
}
