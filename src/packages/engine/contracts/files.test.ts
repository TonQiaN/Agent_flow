import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractRegistry } from './registry.js';
import { FileContractRegistry, isArtifactPath } from './files.js';
import type { FileContract, FileEntry, FileRule } from './files.js';

const rule: FileRule = { id: 'answer', kind: 'file', match: 'answer.json', minCount: 1, maxCount: 1, maxBytes: 64, mediaTypes: ['application/json'], jsonContract: 'answer-json' };
const contract: FileContract = { rules: [rule], maxFiles: 10, maxTotalBytes: 1000, unmatched: 'reject' };
const answer: FileEntry = { path: 'answer.json', kind: 'file', bytes: 9, mediaType: 'application/json', json: { sum: 6 } };
function registry(definition: unknown = contract): FileContractRegistry {
  const json = new ContractRegistry(); json.register('answer-json', { type: 'object', properties: { sum: { const: 6, type: 'integer' } }, required: ['sum'], additionalProperties: false });
  const files = new FileContractRegistry(json); files.register('answer', definition); return files;
}
function codes(definition: FileContract, entries: FileEntry[]): string[] {
  const result = registry(definition).check('answer', entries); return result.valid ? [] : result.issues.map(issue => issue.code);
}

test('file definitions reject unknown fields, unresolved schemas and unsupported patterns; snapshots are independent', () => {
  for (const patch of [{ rules: [{ ...rule, match: '../answer.json' }] }, { rules: [{ ...rule, match: 'a**b' }] },
    { rules: [{ ...rule, maxCount: 0 }] }, { rules: [{ ...rule, jsonContract: 'missing' }] }, { rules: [rule, rule] },
    { rules: [{ ...rule, kind: 'tree' }] }, { rules: [{ ...rule, maxFiles: 1 }] }, { unmatched: 'ignore' }, { extra: true }, { maxFiles: -1 }]) {
    assert.throws(() => registry({ ...contract, ...patch }), /INVALID_FILE_CONTRACT/);
  }
  const definition = structuredClone(contract); const r = registry(definition);
  (definition.rules[0] as { maxBytes: number }).maxBytes = 0;
  (r.definition('answer').rules[0] as { maxBytes: number }).maxBytes = 0;
  assert.equal(r.check('answer', [answer]).valid, true);
  assert.throws(() => r.register('answer', contract), /DUPLICATE_FILE_CONTRACT/);
  assert.throws(() => r.check('missing', []), /UNKNOWN_FILE_CONTRACT/);
});

test('mandatory, optional, count, size, total, media and JSON constraints locate their failures', () => {
  assert.ok(codes(contract, []).includes('COUNT'));
  assert.deepEqual(codes({ ...contract, rules: [{ ...rule, minCount: 0 }] }, []), []);
  assert.ok(codes(contract, [{ ...answer, bytes: 65 }]).includes('MAX_BYTES'));
  assert.ok(codes({ ...contract, maxTotalBytes: 1 }, [answer]).includes('MAX_TOTAL_BYTES'));
  assert.ok(codes({ ...contract, maxFiles: 0 }, [answer]).includes('MAX_FILES'));
  assert.ok(codes(contract, [{ ...answer, mediaType: 'text/plain' }]).includes('MEDIA_TYPE'));
  const result = registry().check('answer', [{ ...answer, json: { sum: 7 } }]);
  assert.deepEqual(result, { valid: false, issues: [{ path: 'answer.json', rule: 'answer', code: 'JSON_CONTRACT' }] });
});

test('directory trees preserve structure and match bounded members without a producer manifest', () => {
  const tree: FileRule = { ...rule, id: 'bundle', kind: 'tree', match: 'reports/*', minFiles: 1, maxFiles: 2 };
  const entries: FileEntry[] = [{ path: 'reports', kind: 'directory' }, { path: 'reports/student', kind: 'directory' },
    { path: 'reports/student/nested', kind: 'directory' }, { ...answer, path: 'reports/student/nested/answer.json' }];
  const r = registry({ ...contract, rules: [tree] }); const result = r.check('answer', entries);
  assert.equal(result.valid, true);
  assert.ok(codes({ ...contract, rules: [{ ...tree, maxFiles: 0, minFiles: 0 }] }, entries).includes('TREE_FILE_COUNT'));
  const withEmpty = r.check('answer', [...entries, { path: 'unclaimed', kind: 'directory' }]);
  assert.equal(withEmpty.valid, true); if (withEmpty.valid) assert.ok(!withEmpty.directories.includes('unclaimed'));
});

test('glob semantics, unmatched files and overlapping tree/file claims never pick an arbitrary winner', () => {
  const entries: FileEntry[] = [{ path: 'a', kind: 'directory' }, { ...answer, path: 'a/answer.json' }];
  assert.deepEqual(codes({ ...contract, rules: [{ ...rule, match: '**/answe?.json' }] }, entries), []);
  assert.deepEqual(codes({ ...contract, rules: [{ ...rule, match: '**/answer.json' }] }, [answer]), []);
  assert.ok(codes(contract, entries).includes('UNMATCHED_ENTRY'));
  const tree: FileRule = { ...rule, id: 'tree', kind: 'tree', match: 'a', minFiles: 1, maxFiles: 2 };
  assert.ok(codes({ ...contract, rules: [tree, { ...rule, match: '**/*.json' }] }, entries).includes('AMBIGUOUS_MATCH'));
  assert.ok(codes({ ...contract, rules: [rule, { ...rule, id: 'other' }] }, [answer]).includes('AMBIGUOUS_MATCH'));
  const nested = [...entries, { path: 'a/b', kind: 'directory' } as const];
  assert.ok(codes({ ...contract, rules: [{ ...tree, match: '**', maxCount: 3, minFiles: 0 }] }, nested).includes('AMBIGUOUS_MATCH'));
});

test('invalid paths, duplicate entries and missing directory parents fail before matching', () => {
  for (const path of ['', '/', '/abs', '..', 'a/../b', 'a//b', 'a\\b', 'a\0b', 'C:file', 'a/']) assert.equal(isArtifactPath(path), false);
  assert.ok(codes(contract, [answer, answer]).includes('DUPLICATE_PATH'));
  assert.ok(codes(contract, [{ ...answer, path: 'missing/answer.json' }]).includes('MISSING_PARENT_DIRECTORY'));
  assert.ok(codes(contract, [{ ...answer, bytes: NaN }]).includes('INVALID_ENTRY'));
});
