import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractRegistry, DefinitionError } from '../index.js';

const failure = (code: string) => (error: unknown) => error instanceof DefinitionError && error.code === code;

test('strict draft 2020-12 contracts validate formats, required fields and extra fields without coercing', () => {
  const registry = new ContractRegistry();
  registry.register('record', { type: 'object', properties: { amount: { type: 'number' }, date: { type: 'string', format: 'date' } },
    required: ['amount', 'date'], additionalProperties: false });
  assert.equal(registry.check('record', { amount: 3, date: '2026-09-09' }).valid, true);
  for (const input of [{ amount: '3', date: '2026-09-09' }, { amount: 3, date: '2026-02-30' }, { amount: 3 }, { amount: 3, date: '2026-09-09', secret: 'private' }]) {
    const before = JSON.stringify(input);
    const result = registry.check('record', input);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(input), before);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('registration rejects malformed schemas, async/remote refs, unknown formats and unresolved local refs', () => {
  const registry = new ContractRegistry();
  for (const schema of [null, { type: 'typo' }, { unknownKeyword: true }, { type: 'string', format: 'not-installed' },
    { $ref: 'https://example.invalid/schema' }, { $ref: '#/$defs/missing' }, { $async: true, type: 'number' },
    { type: 'object', properties: { x: { $ref: 'file:///secret' } } }]) {
    assert.throws(() => registry.register('invalid', schema), failure('INVALID_CONTRACT_SCHEMA'));
  }
  registry.register('local', { $defs: { count: { type: 'integer' } }, $ref: '#/$defs/count' });
  assert.equal(registry.check('local', 2).valid, true);
  assert.equal(registry.check('local', 2.2).valid, false);
  assert.throws(() => registry.register('local', true), failure('DUPLICATE_CONTRACT'));
  assert.throws(() => registry.check('absent', 2), failure('UNKNOWN_CONTRACT'));
});

test('schema snapshot is independent and data containing reference-like fields is allowed', () => {
  const registry = new ContractRegistry();
  const schema = { type: 'number', minimum: 5 };
  registry.register('minimum', schema);
  schema.minimum = 0;
  assert.equal(registry.check('minimum', 3).valid, false);
  registry.register('literal', { const: { $ref: 'literal-user-data' } });
  assert.equal(registry.check('literal', { $ref: 'literal-user-data' }).valid, true);
  registry.register('defaults', { type: 'object', properties: { x: { type: 'number', default: 3 } }, required: ['x'] });
  assert.equal(registry.check('defaults', {}).valid, false);
});

test('non JSON values cannot pass even a permissive contract; getters are not invoked', () => {
  const registry = new ContractRegistry();
  registry.register('any', true);
  const cycle: unknown[] = []; cycle.push(cycle);
  let getterCalls = 0;
  const accessor = { get value() { getterCalls++; return 'secret'; } };
  for (const value of [undefined, NaN, Infinity, 2n, new Date(), new Map(), { x: undefined }, [undefined], Array(1), cycle,
    accessor, Object.defineProperty({}, 'hidden', { value: 3 }), { [Symbol('x')]: 3 }]) assert.equal(registry.check('any', value).valid, false);
  assert.equal(getterCalls, 0);
  assert.equal(registry.check('any', JSON.parse('{"__proto__":{"x":1}}')).valid, true);
  const shared = { value: 1 };
  assert.equal(registry.check('any', [shared, shared]).valid, true);
});
