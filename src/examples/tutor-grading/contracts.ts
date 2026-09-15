import { ContractRegistry, FileContractRegistry } from '@agentflow/engine';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', pattern: '^[a-z0-9-]+$' }, score = { type: 'integer', minimum: 0, maximum: 100 };
export function gradingContracts() {
  const json = new ContractRegistry();
  json.register('paper-json', object({ paperId: id, questions: { type: 'array', minItems: 1, maxItems: 10, items: object({ id, prompt: { type: 'string' }, maxScore: score }) } }));
  json.register('key-json', { type: 'object', minProperties: 1, maxProperties: 10, additionalProperties: { type: 'number' } });
  json.register('submission-json', object({ studentId: id, answers: { type: 'array', minItems: 1, maxItems: 10, items: object({ questionId: id, answer: { type: 'number' }, page: { type: 'integer', minimum: 1 } }) } }));
  json.register('candidate-json', object({ paperId: id, studentId: id, revision: { type: 'integer', minimum: 0 },
    answers: { type: 'array', minItems: 1, maxItems: 10, items: object({ questionId: id, score, evidence: object({ page: { type: 'integer', minimum: 1 }, answer: { type: 'number' } }) }) }, total: score, maxTotal: score }));
  json.register('gate-json', object({ decision: { enum: ['passed', 'revise', 'rejected'] }, candidateHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, findings: { type: 'array', items: { type: 'string' } } }));
  json.register('publication-json', object({ workoutId: id, paperId: id, studentId: id, total: score, maxTotal: score,
    candidateHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reportHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sourceFiles: { type: 'array', minItems: 3, maxItems: 3, items: object({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) } }));
  json.register('effect-receipt', object({ schema: { const: 'agentflow-effect-receipt/v1' }, requestId: id, componentId: id, target: id, key: id, serviceIdentity: id,
    mode: { enum: ['dry-run', 'apply'] }, status: { enum: ['simulated', 'applied', 'already-applied'] }, reference: { type: ['string', 'null'] } }));
  const files = new FileContractRegistry(json);
  const rule = (name: string, path: string, schema: string, required = true) => ({ id: name, kind: 'file', match: path, minCount: required ? 1 : 0, maxCount: 1,
    mediaTypes: ['application/json'], jsonContract: schema, maxBytes: 16384 });
  const source = [rule('paper', 'source/paper.json', 'paper-json'), rule('key', 'source/key.json', 'key-json'), rule('submission', 'source/submission.json', 'submission-json')];
  for (const [name, extra] of [['source-files', []], ['candidate-files', [rule('candidate', 'candidate.json', 'candidate-json'), rule('gate', 'gate-report.json', 'gate-json', false)]],
    ['reviewed-files', [rule('candidate', 'candidate.json', 'candidate-json'), rule('gate', 'gate-report.json', 'gate-json')]]] as const) {
    files.register(name, { rules: [...source, ...extra], maxFiles: 5, maxTotalBytes: 81920, unmatched: 'reject' });
  }
  files.register('publishable-files', { rules: [...source, rule('candidate', 'candidate.json', 'candidate-json'), rule('gate', 'gate-report.json', 'gate-json'), rule('publication', 'publication.json', 'publication-json')], maxFiles: 6, maxTotalBytes: 98304, unmatched: 'reject' });
  return { json, files };
}
