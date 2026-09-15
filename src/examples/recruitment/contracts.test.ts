import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, evidenceErrors, recommendationErrors } from './contracts.js';
import type { RecruitmentState } from './contracts.js';
const state: RecruitmentState = { job: { name: '开发', notes: '' }, candidates: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }], documents: [
  { id: 'd1', owner: 'job', kind: 'job', name: '岗位', storedName: 'document-0.md', pages: [{ page: 1, text: '需要 TypeScript', method: 'text' }] },
  { id: 'd2', owner: 'c1', kind: 'resume', name: 'A', storedName: 'document-1.md', pages: [{ page: 1, text: '熟悉 TypeScript。', method: 'text' }] },
  { id: 'd3', owner: 'c2', kind: 'resume', name: 'B', storedName: 'document-2.md', pages: [{ page: 1, text: 'JavaScript 开发。', method: 'text' }] },
], requirements: [{ id: 'R1', label: 'TypeScript', kind: '必需', evidence: [{ documentId: 'd1', page: 1, quote: '需要 TypeScript' }] }] };
test('one job and candidate-owned original evidence are required', () => {
  validateInput(state); assert.throws(() => validateInput({ ...state, documents: [...state.documents, { ...state.documents[0], id: 'd4' }] }));
  assert.equal(evidenceErrors([{ documentId: 'd2', page: 1, quote: '熟悉 TypeScript。' }], state.documents, 'c1').length, 0);
  for (const reference of [{ documentId: 'd2', page: 2, quote: '熟悉' }, { documentId: 'd2', page: 1, quote: '没有 TypeScript' }, { documentId: 'd3', page: 1, quote: 'JavaScript 开发。' }]) assert.ok(evidenceErrors([reference], state.documents, 'c1').length);
});
test('unknown evidence needs a stated binary effect; scores and third outcomes are rejected', () => {
  const result = { candidateId: 'c2', recommendation: '推荐不通过', rationale: '必需项缺少材料', decisiveRequirementIds: ['R1'], uncertaintyImpact: '必需项未知，推荐不通过', criteria: [{ requirementId: 'R1', state: '未证实', reason: '只见 JavaScript', evidence: [] }], questions: ['请演示 TypeScript 项目'] };
  assert.deepEqual(recommendationErrors(result, state, 'c2'), []);
  for (const invalid of [{ ...result, recommendation: '待定' }, { ...result, uncertaintyImpact: '' }, { ...result, score: 90 }, { ...result, candidateId: 'c1' }]) assert.ok(recommendationErrors(invalid, state, 'c2').length);
});
