import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentDefinition, ComponentResult, JsonObject } from '@agentflow/domain';
import { ContractRegistry, ComponentRegistry, ComponentExecutor, FunctionRegistry, DefinitionError } from '../index.js';
import type { ComponentFunction } from '../index.js';

const identity = { runId: 'r1', nodeTaskId: 't1', attemptId: 'a1', attemptNumber: 1 };
const definition: ComponentDefinition = { id: 'check', kind: 'gate', inputContract: 'input',
  outcomes: { passed: 'number', rejected: 'reason' }, implementation: 'gate-v1' };
const errorCode = (code: string) => (error: unknown) => error instanceof DefinitionError && error.code === code;
function setup(implementation: ComponentFunction) {
  const contracts = new ContractRegistry();
  contracts.register('input', { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false });
  contracts.register('number', { type: 'number' });
  contracts.register('reason', { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false });
  const components = new ComponentRegistry(contracts);
  components.register(definition);
  const functions = new FunctionRegistry();
  functions.register('gate-v1', implementation);
  const executor = new ComponentExecutor(contracts, components, functions);
  return { contracts, components, functions, executor };
}

test('business rejection is accepted and tied to its declared output contract', async () => {
  const { executor } = setup(() => ({ outcome: 'rejected', output: { reason: 'out of range' } }));
  assert.deepEqual(await executor.execute('check', { n: 2 }, identity), {
    identity, componentId: 'check', status: 'accepted', outcome: 'rejected', output: { reason: 'out of range' },
  });
});

test('invalid input never invokes implementation; diagnostics exclude values', async () => {
  let calls = 0;
  const { executor } = setup(() => { calls++; return { outcome: 'passed', output: 1 }; });
  const result = await executor.execute('check', { n: 'private-token' }, identity);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.code, 'INVALID_INPUT');
    assert.equal(result.issues[0]?.instancePath, '/n');
  }
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('implementation/protocol/output failures stay separate from business outcomes', async () => {
  const cases: [ComponentFunction, string][] = [
    [() => { throw new Error('private-token'); }, 'IMPLEMENTATION_FAILED'],
    [async () => { throw 'private-token'; }, 'IMPLEMENTATION_FAILED'],
    [(() => undefined) as unknown as ComponentFunction, 'INVALID_RESULT'],
    [() => ({ outcome: 'passed', output: NaN }), 'INVALID_RESULT'],
    [() => ({ outcome: 'missing', output: 1 }), 'UNDECLARED_OUTCOME'],
    [() => ({ outcome: 'toString', output: 1 }), 'UNDECLARED_OUTCOME'],
    [() => ({ outcome: 'rejected', output: 1 }), 'INVALID_OUTPUT'],
    [(() => ({ outcome: 'passed', output: 1, extra: 1 })) as ComponentFunction, 'INVALID_RESULT'],
  ];
  for (const [implementation, code] of cases) {
    const result = await setup(implementation).executor.execute('check', { n: 2 }, identity);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('private-token'));
  }
});

test('concurrent invocations own independent inputs and accepted outputs are snapshots', async () => {
  const input = { n: 5 };
  const rawResult: ComponentResult = { outcome: 'rejected', output: { reason: 'original' } };
  let calls = 0;
  const { executor } = setup(async value => {
    const object = value as JsonObject;
    assert.equal(object['n'], 5);
    object['n'] = ++calls;
    await Promise.resolve();
    return rawResult;
  });
  const [first, second] = await Promise.all([
    executor.execute('check', input, identity),
    executor.execute('check', input, { ...identity, nodeTaskId: 't2', attemptId: 'a2' }),
  ]);
  assert.deepEqual(input, { n: 5 });
  (rawResult.output as JsonObject)['reason'] = 'changed';
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted');
  if (first.status === 'accepted' && second.status === 'accepted') {
    assert.deepEqual(first.output, { reason: 'original' });
    (first.output as JsonObject)['reason'] = 'caller-change';
    assert.deepEqual(second.output, { reason: 'original' });
  }
});

test('definition errors resolve before invocation and definitions cannot be changed through aliases', async () => {
  let calls = 0;
  const { executor, components, functions } = setup(() => { calls++; return { outcome: 'passed', output: 1 }; });
  assert.throws(() => components.register(definition), errorCode('DUPLICATE_COMPONENT'));
  assert.throws(() => functions.register('gate-v1', () => ({ outcome: 'passed', output: 1 })), errorCode('DUPLICATE_IMPLEMENTATION'));
  assert.throws(() => components.register({ ...definition, id: 'missing', inputContract: 'absent' }), errorCode('UNKNOWN_CONTRACT'));
  assert.throws(() => components.register({ ...definition, id: 'empty', outcomes: {} }), errorCode('INVALID_COMPONENT'));
  const mutable = { ...definition, id: 'copy', outcomes: { passed: 'number' }, implementation: 'absent' };
  components.register(mutable);
  mutable.outcomes.passed = 'reason';
  assert.equal(components.get('copy').outcomes['passed'], 'number');
  assert.throws(() => { (components.get('copy').outcomes as Record<string, string>)['passed'] = 'reason'; }, TypeError);
  await assert.rejects(executor.execute('copy', { n: 2 }, identity), errorCode('UNKNOWN_IMPLEMENTATION'));
  await assert.rejects(executor.execute('missing', { n: 2 }, identity), errorCode('UNKNOWN_COMPONENT'));
  await assert.rejects(executor.execute('check', { n: 2 }, { ...identity, attemptNumber: 0 }), errorCode('INVALID_EXECUTION_IDENTITY'));
  for (const kind of ['agent', 'effect'] as const) {
    components.register({ ...definition, id: kind, kind });
    await assert.rejects(executor.execute(kind, { n: 2 }, identity), errorCode('UNSUPPORTED_EXECUTION_KIND'));
  }
  assert.equal(calls, 0);
});

test('identity is captured before asynchronous execution and readonly to implementation', async () => {
  const mutable = { ...identity };
  const { executor } = setup(async (_input, received) => {
    assert.equal(Object.isFrozen(received), true);
    await Promise.resolve();
    return { outcome: 'passed', output: 1 };
  });
  const resultPromise = executor.execute('check', { n: 2 }, mutable);
  mutable.attemptId = 'changed';
  assert.equal((await resultPromise).identity.attemptId, 'a1');
});
