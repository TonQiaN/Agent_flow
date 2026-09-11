import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from './registry.js';
import { ContractRegistry } from '../contracts/registry.js';
import { EFFECT_RECEIPT_SCHEMA, EffectExecutor } from './effect-executor.js';
import type { EffectAdapter, EffectAdapterRequest, EffectApproval, EffectReceipt, EffectRequest, EffectResult } from './effect-executor.js';

const request = (node = 'first'): EffectRequest => ({ identity: { runId: 'run', nodeTaskId: node, attemptId: 'a1', attemptNumber: 1 },
  componentId: 'publish', target: 'workout-1', key: 'publication-1', input: { value: 1, meta: { a: 1, b: 2 } }, mode: 'apply' });
const resultCode = (result: EffectResult): string => { assert.equal(result.status, 'failed'); if (result.status !== 'failed') throw new Error(); return result.code; };
function fixture(referenceConst?: string) {
  const contracts = new ContractRegistry(); contracts.register('input', { type: 'object', properties: { value: { type: 'integer' }, meta: { type: 'object', additionalProperties: { type: 'integer' } } }, required: ['value'], additionalProperties: false });
  for (const status of ['simulated', 'applied', 'already-applied']) contracts.register(status, { type: 'object', additionalProperties: false,
    properties: { schema: { const: EFFECT_RECEIPT_SCHEMA }, requestId: { type: 'string' }, componentId: { type: 'string' }, target: { type: 'string' }, key: { type: 'string' },
      serviceIdentity: { type: 'string' }, mode: { enum: ['dry-run', 'apply'] }, status: { const: status }, reference: referenceConst ? { const: referenceConst } : { type: ['string', 'null'] } },
    required: ['schema', 'requestId', 'componentId', 'target', 'key', 'serviceIdentity', 'mode', 'status', 'reference'] });
  const components = new ComponentRegistry(contracts); const definition = { id: 'publish', kind: 'effect' as const, implementation: 'publish-impl', inputContract: 'input',
    outcomes: { simulated: 'simulated', applied: 'applied', 'already-applied': 'already-applied' } };
  components.register(definition); components.register({ ...definition, id: 'other-publish' });
  let applies = 0, simulations = 0;
  const reply = (r: EffectAdapterRequest): EffectReceipt => ({ schema: EFFECT_RECEIPT_SCHEMA, requestId: r.requestId, componentId: r.componentId,
    target: r.target, key: r.key, serviceIdentity: r.serviceIdentity, mode: r.mode, status: r.mode === 'apply' ? 'applied' : 'simulated', reference: r.mode === 'apply' ? 'record-1' : null });
  let apply = async (r: EffectAdapterRequest): Promise<EffectReceipt> => reply(r);
  const adapter: EffectAdapter = { implementation: 'publish-impl', serviceIdentity: 'business-service', async simulate(r) { simulations++; return reply(r); }, async apply(r) { applies++; return apply(r); } };
  const executor = new EffectExecutor(contracts, components, adapter);
  return { contracts, components, definition, executor, adapter, reply, apply: (fn: typeof apply) => { apply = fn; }, applies: () => applies, simulations: () => simulations };
}

test('Effect defaults to dry-run, never consumes operation keys or calls apply, and validates inputs first', async () => {
  const f = fixture(), { mode: _mode, ...dry } = request();
  const result = await f.executor.execute(dry); assert.equal(result.status, 'accepted'); if (result.status === 'accepted') assert.equal(result.outcome, 'simulated');
  assert.equal(f.applies(), 0); assert.equal(f.simulations(), 1); assert.equal(f.executor.query(dry.key), null);
  assert.equal(resultCode(await f.executor.execute({ ...request('bad'), input: { value: 'wrong' } })), 'INPUT_CONTRACT_FAILED'); assert.equal(f.applies(), 0);
  await assert.rejects(f.executor.execute('PRIVATE_INVALID_REQUEST' as unknown as EffectRequest), /INVALID_EFFECT_REQUEST/);
  assert.throws(() => f.executor.authorize(dry), /INVALID_EFFECT_APPROVAL_REQUEST/);
  const a = request('dry-grant'), token = f.executor.authorize(a);
  assert.equal(resultCode(await f.executor.execute({ ...a, mode: 'dry-run' }, token)), 'EFFECT_APPROVAL_NOT_APPLICABLE');
});

test('missing, cloned, foreign, consumed and scope-changed approvals cannot write', async () => {
  const f = fixture();
  assert.equal(resultCode(await f.executor.execute(request('missing'))), 'EFFECT_NOT_AUTHORIZED');
  const cloneRequest = request('cloned'), token = f.executor.authorize(cloneRequest);
  assert.equal(resultCode(await f.executor.execute(cloneRequest, JSON.parse(JSON.stringify(token)) as EffectApproval)), 'EFFECT_NOT_AUTHORIZED');
  const foreignRequest = request('foreign');
  assert.equal(resultCode(await f.executor.execute(foreignRequest, fixture().executor.authorize(foreignRequest))), 'EFFECT_NOT_AUTHORIZED');
  const changes: Partial<EffectRequest>[] = [{ componentId: 'other-publish' }, { target: 'other-target' }, { key: 'other-key' }, { input: { value: 2 } },
    { identity: { ...request().identity, runId: 'other-run' } }, { identity: { ...request().identity, attemptNumber: 2 } }];
  for (const [i, change] of changes.entries()) {
    const original = request(`scope-${i}`), grant = f.executor.authorize(original);
    assert.equal(resultCode(await f.executor.execute({ ...original, ...change }, grant)), 'EFFECT_NOT_AUTHORIZED');
  }
  assert.equal(f.applies(), 0);
  const valid = request('valid'), grant = f.executor.authorize(valid); assert.equal((await f.executor.execute(valid, grant)).status, 'accepted');
  assert.equal(resultCode(await f.executor.execute(request('reuse-grant'), grant)), 'EFFECT_NOT_AUTHORIZED'); assert.equal(f.applies(), 1);
});

test('same canonical request reuses validated evidence while changed input, target or component conflicts', async () => {
  const f = fixture(), first = request(); const output = await f.executor.execute(first, f.executor.authorize(first));
  assert.equal(output.status, 'accepted'); if (output.status !== 'accepted') throw new Error();
  (output.output as { reference: string }).reference = 'forged';
  const view = f.executor.query(first.key)!; (view.receipt as { reference: string }).reference = 'also-forged';
  const next = { ...request('second'), input: { meta: { b: 2, a: 1 }, value: 1 } };
  const reused = await f.executor.execute(next, f.executor.authorize(next)); assert.equal(reused.status, 'accepted');
  if (reused.status !== 'accepted') throw new Error();
  assert.equal(reused.outcome, 'already-applied'); assert.equal(reused.output.reference, 'record-1'); assert.deepEqual(reused.identity, next.identity);
  for (const [index, change] of [{ input: { value: 7 } }, { target: 'another' }, { componentId: 'other-publish' }].entries()) {
    const different = { ...request(`conflict-${index}`), ...change };
    assert.equal(resultCode(await f.executor.execute(different, f.executor.authorize(different))), 'EFFECT_KEY_CONFLICT');
  }
  assert.equal(f.applies(), 1); assert.equal(f.executor.query(first.key)!.state, 'applied');
});

test('pending operations reserve synchronously and request mutations cannot change the operation or grant', async () => {
  const f = fixture(); let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }); let seen: EffectAdapterRequest | null = null;
  f.apply(async r => { seen = structuredClone(r); await pending; return f.reply(r); });
  const first = request(), approval = f.executor.authorize(first), running = f.executor.execute(first, approval);
  (first.input as { value: number }).value = 99; (first.identity as { runId: string }).runId = 'forged';
  assert.equal(f.executor.query('publication-1')!.state, 'pending');
  const second = request('second'); const blocked = await f.executor.execute(second, f.executor.authorize(second));
  assert.equal(resultCode(blocked), 'EFFECT_IN_PROGRESS'); if (blocked.status === 'failed') assert.equal(blocked.stopped, false);
  const duplicate = await f.executor.execute(request(), approval); assert.equal(resultCode(duplicate), 'DUPLICATE_EFFECT_ATTEMPT');
  finish(); const completed = await running; assert.equal(completed.status, 'accepted');
  assert.deepEqual((seen as unknown as EffectAdapterRequest).input, request().input); assert.deepEqual(completed.identity, request().identity); assert.equal(f.applies(), 1);
});

test('a write followed by a lost response remains unknown and cannot be sent again', async () => {
  const f = fixture(); let externalWrites = 0;
  f.apply(async () => { externalWrites++; throw new Error('PRIVATE_SERVICE_FAILURE'); });
  const first = request(); const result = await f.executor.execute(first, f.executor.authorize(first));
  assert.equal(resultCode(result), 'EFFECT_RESULT_UNKNOWN'); assert.ok(!JSON.stringify(result).includes('PRIVATE_SERVICE_FAILURE'));
  if (result.status === 'failed') assert.equal(result.stopped, false);
  assert.equal(f.executor.query(first.key)!.state, 'unknown');
  const next = request('next'); assert.equal(resultCode(await f.executor.execute(next, f.executor.authorize(next))), 'EFFECT_RESULT_UNKNOWN');
  assert.equal(externalWrites, 1); assert.equal(f.applies(), 1);
});

test('mismatched receipts and post-write output violations poison the reservation instead of enabling replay', async () => {
  const changes: Partial<EffectReceipt>[] = [{ requestId: 'wrong' }, { componentId: 'wrong' }, { target: 'wrong' }, { key: 'wrong' }, { serviceIdentity: 'wrong' },
    { mode: 'dry-run' }, { status: 'already-applied' }, { reference: '/private/path' }];
  for (const change of changes) {
    const f = fixture(); f.apply(async r => ({ ...f.reply(r), ...change })); const r = request();
    assert.equal(resultCode(await f.executor.execute(r, f.executor.authorize(r))), 'EFFECT_RESULT_UNKNOWN'); assert.equal(f.executor.query(r.key)!.state, 'unknown');
  }
  const origin = fixture(), original = request();
  const prior = await origin.executor.execute(original, origin.executor.authorize(original));
  if (prior.status !== 'accepted') throw new Error();
  const another = fixture(); another.apply(async () => prior.output);
  const changedInput = { ...request(), input: { value: 9 } };
  assert.equal(resultCode(await another.executor.execute(changedInput, another.executor.authorize(changedInput))), 'EFFECT_RESULT_UNKNOWN');
  const f = fixture('must-be-this-reference'), r = request();
  const failed = await f.executor.execute(r, f.executor.authorize(r)); assert.equal(resultCode(failed), 'OUTPUT_CONTRACT_FAILED');
  assert.equal(f.executor.query(r.key)!.state, 'unknown');
  const next = request('next'); assert.equal(resultCode(await f.executor.execute(next, f.executor.authorize(next))), 'EFFECT_RESULT_UNKNOWN'); assert.equal(f.applies(), 1);
});

test('cancellation before dispatch causes no write or reservation; adapter method replacement cannot retarget execution', async () => {
  const f = fixture(), r = request();
  const cancelled = await f.executor.execute(r, f.executor.authorize(r), { requested: () => true });
  assert.equal(resultCode(cancelled), 'CANCELLED'); assert.equal(f.applies(), 0); assert.equal(f.executor.query(r.key), null);
  f.adapter.apply = async () => { throw new Error('changed adapter'); };
  const next = request('next'); assert.equal((await f.executor.execute(next, f.executor.authorize(next))).status, 'accepted'); assert.equal(f.applies(), 1);
});
