import type { Artifact, AttemptTiming } from '../display-types.js';
import type { RunView } from '@agentflow/integrations';
export const timestamp = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? '未记录'
  : new Date(v).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, fractionalSecondDigits: 3 });
export const clockTime = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? '未记录'
  : new Date(v).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, fractionalSecondDigits: 3 });
export function duration(start: number | null | undefined, end: number | null | undefined) {
  if (start == null || end == null) return '未记录';
  const ms = end - start;
  if (ms < 0) return '时钟异常';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${((ms % 60000) / 1000).toFixed(1)} 秒`;
}
export const sameAttempt = (a: any, b: any) => !!a && !!b && a.runId === b.runId && a.nodeTaskId === b.nodeTaskId && a.attemptId === b.attemptId && a.attemptNumber === b.attemptNumber;
export function attemptTiming(attempts: AttemptTiming[] | undefined, identity: unknown) { return attempts?.find(a => sameAttempt(a.identity, identity)); }
export function attemptDuration(value: AttemptTiming | undefined, at?: number | null) {
  if (!value || value.startedAt === null) return '未记录';
  return !value.ended && at != null ? `已用 ${duration(value.startedAt, at)}` : duration(value.startedAt, value.finishedAt);
}
export function fileOwner(file: Artifact) {
  return file.sources?.find(s => s.role !== 'input' && s.nodeTaskId && s.recordedAt !== undefined)
    ?? file.sources?.find(s => s.role !== 'input' && s.nodeTaskId) ?? file.sources?.[0];
}
export function fileGroup(file: Artifact, runs: { view: RunView }[]) {
  const owner = fileOwner(file);
  const runId = owner?.runId ?? file.runId, task = owner?.nodeTaskId ?? file.nodeTaskId;
  const view = runs.find(r => r.view.runId === runId)?.view;
  const node = owner?.node ?? view?.snapshot.steps.find(s => s.result.identity.nodeTaskId === task)?.node;
  const attemptNumber = owner?.attemptNumber;
  return { key: owner?.role === 'input' && !task ? 'input' : node ? `${runId}/${node}/${task}/${attemptNumber ?? ''}` : 'unassigned',
    node, runId, nodeTaskId: task, attemptNumber, role: owner?.role ?? 'unassigned' };
}
export function previewKind(file: Pick<Artifact, 'mediaType' | 'name'>): 'pdf' | 'image' | 'json' | 'code' | 'text' | 'binary' {
  if (file.mediaType === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (/\.(py|pyi|js|jsx|ts|tsx|mjs|cjs|sh|bash|sql|r|java|c|cpp|h|go|rs|html|svg|css|yaml|yml|toml)$/i.test(file.name)) return 'code';
  if (/\.(json|ipynb)$/i.test(file.name) || file.mediaType === 'application/json') return 'json';
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.mediaType)) return 'image';
  if (file.mediaType.startsWith('text/') || /\.(md|txt|log|csv|xml)$/i.test(file.name)) return 'text';
  return 'binary';
}
export function isRecruitmentOutput(workflowId: string | undefined, value: any) {
  return workflowId === 'recruitment' && value && ['recommendations', 'candidates', 'requirements', 'documents'].every(k => Array.isArray(value[k]))
    && value.recommendations.every((r: any) => r && Array.isArray(r.criteria) && Array.isArray(r.questions) && r.criteria.every((c: any) => c && Array.isArray(c.evidence)));
}
