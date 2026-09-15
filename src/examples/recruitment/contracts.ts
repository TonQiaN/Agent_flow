export const dimensions = ['岗位条件', '技能匹配', '项目与经验', '领域与职责'] as const;
export type CriterionState = '已支持' | '不支持' | '未证实' | '材料冲突';
export interface Evidence { documentId: string; page: number; quote: string }
export interface Document { id: string; owner: string; kind: 'job' | 'resume' | 'supplement'; name: string; storedName: string; pages?: { page: number; text: string; method: string }[]; notes?: string[] }
export interface Requirement { id: string; label: string; kind: '必需' | '职责' | '加分'; evidence: Evidence[] }
export interface Criterion { requirementId: string; state: CriterionState; reason: string; evidence: Evidence[] }
export interface Review { candidateId: string; dimension: string; criteria: Criterion[]; notes: string[]; round: number }
export interface Recommendation { candidateId: string; recommendation: '推荐通过' | '推荐不通过'; rationale: string; decisiveRequirementIds: string[]; uncertaintyImpact: string; criteria: Criterion[]; questions: string[] }
export interface RecruitmentState {
  job: { name: string; notes: string }; candidates: { id: string; name: string }[]; documents: Document[];
  requirements?: Requirement[]; reviews?: Review[]; audits?: { candidateId: string; issues: { requirementId: string; reason: string }[]; summary: string }[];
  recommendations?: Recommendation[]; round?: number; repairCandidates?: string[]; repairReasons?: string[]; scenario?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 30000;
function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export function validateInput(raw: unknown): asserts raw is RecruitmentState {
  assert(object(raw) && object(raw['job']) && text(raw['job']['name']) && Array.isArray(raw['candidates']) && raw['candidates'].length >= 1 && raw['candidates'].length <= 12 && Array.isArray(raw['documents']), 'INVALID_RECRUITMENT_INPUT');
  const people = raw['candidates']; assert(people.every(c => object(c) && typeof c['id'] === 'string' && /^c[1-9][0-9]*$/.test(c['id']) && text(c['name'])) && new Set(people.map(c => c.id)).size === people.length, 'INVALID_CANDIDATE');
  const documents = raw['documents'] as Document[];
  assert(documents.length <= 64 && documents.filter(d => d.owner === 'job' && d.kind === 'job').length === 1, 'SINGLE_JOB_REQUIRED');
  assert(new Set(documents.map(d => d.id)).size === documents.length && documents.every(d => /^d[1-9][0-9]*$/.test(d.id) && /^document-[0-9]+\.(pdf|docx|txt|md|png|jpe?g)$/.test(d.storedName) && ['job', ...people.map(c => c.id)].includes(d.owner)), 'INVALID_DOCUMENT');
  for (const c of people) assert(documents.filter(d => d.owner === c.id && d.kind === 'resume').length === 1, 'ONE_RESUME_PER_CANDIDATE');
}
export function validateRequirements(raw: unknown): asserts raw is Requirement[] {
  assert(Array.isArray(raw) && raw.length > 0 && raw.length <= 24, 'INVALID_REQUIREMENTS');
  assert(raw.every(r => object(r) && typeof r['id'] === 'string' && /^R[1-9][0-9]*$/.test(r['id']) && text(r['label']) && ['必需', '职责', '加分'].includes(String(r['kind'])) && Array.isArray(r['evidence']) && r['evidence'].length > 0) && new Set(raw.map(r => r.id)).size === raw.length, 'INVALID_REQUIREMENT');
}
export function evidenceErrors(evidence: unknown, documents: Document[], owner: string): string[] {
  if (!Array.isArray(evidence)) return ['引用列表无效'];
  const issues: string[] = [];
  for (const item of evidence) {
    if (!object(item) || !text(item['documentId']) || !Number.isSafeInteger(item['page']) || !text(item['quote'])) { issues.push('引用缺少文件、页码或原文'); continue; }
    const document = documents.find(d => d.id === item['documentId'] && (d.owner === 'job' || d.owner === owner));
    const page = document?.pages?.find(p => p.page === item['page']);
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (!page || !normalize(page.text).includes(normalize(item['quote']))) issues.push(`${item['documentId']} 第 ${item['page']} 页引用无法对上原文或材料归属`);
  }
  return issues;
}
export function criterionErrors(raw: unknown, state: RecruitmentState, owner: string, requireAll: boolean): string[] {
  if (!Array.isArray(raw) || !raw.length) return ['缺少逐项结论'];
  const issues: string[] = [], ids = state.requirements!.map(r => r.id), seen = new Set<string>();
  for (const item of raw) {
    if (!object(item) || !ids.includes(String(item['requirementId'])) || !['已支持', '不支持', '未证实', '材料冲突'].includes(String(item['state'])) || !text(item['reason'])) { issues.push('逐项结论无效'); continue; }
    const id = String(item['requirementId']); if (seen.has(id)) issues.push('岗位要求重复'); seen.add(id);
    issues.push(...evidenceErrors(item['evidence'], state.documents, owner));
    if (item['state'] !== '未证实' && (!Array.isArray(item['evidence']) || !item['evidence'].some(e => object(e) && state.documents.some(d => d.id === e['documentId'] && d.owner === owner)))) issues.push(`${id} 缺少候选人原文证据`);
  }
  if (requireAll && ids.some(id => !seen.has(id))) issues.push('岗位要求未逐项覆盖');
  return issues;
}
export function recommendationErrors(raw: unknown, state: RecruitmentState, owner: string): string[] {
  if (!object(raw)) return ['最终结果不是对象'];
  const issues = criterionErrors(raw['criteria'], state, owner, true);
  if (raw['candidateId'] !== owner || !['推荐通过', '推荐不通过'].includes(String(raw['recommendation'])) || !text(raw['rationale'])) issues.push('缺少有效的最终二元推荐及理由');
  if (!Array.isArray(raw['decisiveRequirementIds']) || !raw['decisiveRequirementIds'].length || raw['decisiveRequirementIds'].some(id => !state.requirements!.some(r => r.id === id))) issues.push('缺少决定性岗位要求');
  if (Array.isArray(raw['criteria']) && raw['criteria'].some(c => object(c) && ['未证实', '材料冲突'].includes(String(c['state']))) && !text(raw['uncertaintyImpact'])) issues.push('没有说明未知或冲突怎样影响最终推荐');
  if (!Array.isArray(raw['questions']) || !raw['questions'].every(text)) issues.push('面试问题无效');
  const inspect = (v: unknown): void => { if (Array.isArray(v)) v.forEach(inspect); else if (object(v)) for (const [key, value] of Object.entries(v)) { if (/score|ranking|rank|总分|评分|排名/i.test(key)) issues.push('禁止总分或排名字段'); inspect(value); } };
  inspect(raw); return issues;
}

/** The scheduler owns identity; optional echoed identity must agree with it. */
export function bindReviewIdentity(raw: unknown, candidateId: string, dimension?: string): Record<string, unknown> {
  assert(object(raw), 'INVALID_REVIEW_RESULT');
  assert(raw['candidateId'] === undefined || raw['candidateId'] === candidateId, 'CANDIDATE_RESULT_MISMATCH');
  assert(dimension === undefined || raw['dimension'] === undefined || raw['dimension'] === dimension, 'REVIEW_DIMENSION_MISMATCH');
  return { ...raw, candidateId, ...(dimension ? { dimension } : {}) };
}
