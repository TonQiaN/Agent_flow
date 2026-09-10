import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry, ContractRegistry, EffectExecutor, EffectWorkflowCatalog, FunctionRegistry, JsonFunctionWorkflowCatalog, WorkflowRuntime, compileWorkflow } from '@agentflow/engine';
import type { EffectAdapter, EffectRequest, WorkflowCatalog, WorkflowDefinition, WorkflowRunHandle } from '@agentflow/engine';
import { SimulatedEffectService } from './simulated-service.js';

const secret = 'synthetic-business-credential';
function fixture(wrap: (adapter: EffectAdapter) => EffectAdapter = a => a, credential: string | null = secret) {
  const contracts = new ContractRegistry(); contracts.register('input', { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false });
  contracts.register('receipt', { type: 'object', properties: { schema: { const: 'agentflow-effect-receipt/v1' }, requestId: { type: 'string' }, componentId: { type: 'string' },
    target: { type: 'string' }, key: { type: 'string' }, serviceIdentity: { type: 'string' }, mode: { enum: ['apply', 'dry-run'] },
    status: { enum: ['simulated', 'applied', 'already-applied'] }, reference: { type: ['string', 'null'] } },
    required: ['schema', 'requestId', 'componentId', 'target', 'key', 'serviceIdentity', 'mode', 'status', 'reference'], additionalProperties: false });
  const components = new ComponentRegistry(contracts);
  components.register({ id: 'prepare', kind: 'transform', implementation: 'prepare-impl', inputContract: 'input', outcomes: { done: 'input' } });
  components.register({ id: 'publish', kind: 'effect', implementation: 'publish-impl', inputContract: 'input', outcomes: { simulated: 'receipt', applied: 'receipt', 'already-applied': 'receipt' } });
  const functions = new FunctionRegistry(); functions.register('prepare-impl', input => ({ outcome: 'done', output: { value: (input as { value: number }).value + 1 } }));
  const json = new JsonFunctionWorkflowCatalog(contracts, components, functions), service = new SimulatedEffectService(secret);
  const executor = new EffectExecutor(contracts, components, wrap(service.connect('publish-impl', 'marking-business-identity', credential ?? undefined)));
  const effects = new EffectWorkflowCatalog(contracts, components, executor);
  const catalog: WorkflowCatalog = { resolve: id => id === 'prepare' ? json.resolve(id) : effects.resolve(id) };
  const definition: WorkflowDefinition = { id: 'publish-flow', start: 'prepare', maxSteps: 4, input: { kind: 'json', id: 'input' },
    outcomes: { simulated: { kind: 'json', id: 'receipt' }, applied: { kind: 'json', id: 'receipt' }, reused: { kind: 'json', id: 'receipt' } },
    nodes: { prepare: { component: 'prepare' }, publish: { component: 'publish' } }, routes: [
      { from: 'prepare', outcome: 'done', to: { node: 'publish' } }, { from: 'publish', outcome: 'simulated', to: { end: 'simulated' } },
      { from: 'publish', outcome: 'applied', to: { end: 'applied' } }, { from: 'publish', outcome: 'already-applied', to: { end: 'reused' } }] };
  const operation = () => ({ target: 'workout-1', key: 'publication-1' });
  const approve = (r: EffectRequest) => r.target === 'workout-1' && (r.input as { value: number }).value === 1 ? executor.authorize(r) : undefined;
  return { service, executor, effects, catalog, definition, operation, approve };
}

test('Transform to simulated Effect defaults to dry-run and works without a business credential', async () => {
  const f = fixture(a => a, null); f.effects.register('publish', { operation: f.operation });
  const result = await new WorkflowRuntime().start(compileWorkflow(f.definition, f.catalog), 'dry', { value: 0 }).completion;
  assert.equal(result.status, 'succeeded'); assert.equal(result.outcome, 'simulated'); assert.equal(f.service.writes, 0);
  assert.equal(f.service.read('workout-1'), null); assert.equal(f.executor.query('publication-1'), null);
});

test('scoped host approval writes using a separate business identity, then reuses the same request', async () => {
  const f = fixture(), binding = { mode: 'apply' as const, operation: f.operation, approval: f.approve };
  f.effects.register('publish', binding); binding.approval = () => undefined;
  const plan = compileWorkflow(f.definition, f.catalog), runtime = new WorkflowRuntime();
  const first = await runtime.start(plan, 'first', { value: 0 }).completion;
  assert.equal(first.status, 'succeeded'); assert.equal(first.outcome, 'applied'); assert.equal(f.service.writes, 1);
  assert.deepEqual(f.service.read('workout-1'), { identity: 'marking-business-identity', value: { value: 1 } });
  const second = await runtime.start(plan, 'second', { value: 0 }).completion;
  assert.equal(second.status, 'succeeded'); assert.equal(second.outcome, 'reused'); assert.equal(f.service.writes, 1);
  assert.ok(!JSON.stringify([first, second, f.executor.query('publication-1'), f.service]).includes(secret));
  const denied = await runtime.start(plan, 'different-input', { value: 5 }).completion;
  assert.equal(denied.status, 'failed'); assert.equal(denied.reason, 'EFFECT_NOT_AUTHORIZED'); assert.equal(f.service.writes, 1);
});

test('apply without approval or with the wrong business credential never writes', async () => {
  const noGrant = fixture(); noGrant.effects.register('publish', { mode: 'apply', operation: noGrant.operation });
  const rejected = await new WorkflowRuntime().start(compileWorkflow(noGrant.definition, noGrant.catalog), 'no-grant', { value: 0 }).completion;
  assert.equal(rejected.reason, 'EFFECT_NOT_AUTHORIZED'); assert.equal(noGrant.service.writes, 0);
  const wrongCredential = fixture(a => a, 'wrong-business-credential');
  wrongCredential.effects.register('publish', { mode: 'apply', operation: wrongCredential.operation, approval: wrongCredential.approve });
  const wrong = await new WorkflowRuntime().start(compileWorkflow(wrongCredential.definition, wrongCredential.catalog), 'wrong', { value: 0 }).completion;
  assert.equal(wrong.status, 'failed'); assert.equal(wrongCredential.service.writes, 0); assert.equal(wrongCredential.executor.query('publication-1')!.state, 'unknown');
  assert.ok(!JSON.stringify(wrong).includes('wrong-business-credential'));
});

test('lost post-write reply remains unknown even when cancelled and later Workflow runs cannot resend', async () => {
  let run: WorkflowRunHandle;
  const f = fixture(adapter => ({ ...adapter, async apply(r) { await adapter.apply(r); run.cancel(); throw new Error('PRIVATE_LOST_REPLY'); } }));
  f.effects.register('publish', { mode: 'apply', operation: f.operation, approval: f.approve });
  const plan = compileWorkflow(f.definition, f.catalog), runtime = new WorkflowRuntime();
  run = runtime.start(plan, 'unknown', { value: 0 }); const first = await run.completion;
  assert.equal(first.status, 'failed'); assert.equal(first.cancelRequested, true); assert.equal(first.reason, 'EXECUTION_STOP_UNCONFIRMED');
  assert.equal(f.service.writes, 1); assert.equal(f.executor.query('publication-1')!.state, 'unknown'); assert.ok(!JSON.stringify(first).includes('PRIVATE_LOST_REPLY'));
  const second = await runtime.start(plan, 'next', { value: 0 }).completion;
  assert.equal(second.status, 'failed'); assert.equal(f.service.writes, 1);
});

test('cancellation after a confirmed effect preserves its applied receipt and does not imply rollback', async () => {
  let run: WorkflowRunHandle;
  const f = fixture(adapter => ({ ...adapter, async apply(r) { const receipt = await adapter.apply(r); run.cancel(); return receipt; } }));
  f.effects.register('publish', { mode: 'apply', operation: f.operation, approval: f.approve });
  run = new WorkflowRuntime().start(compileWorkflow(f.definition, f.catalog), 'late-cancel', { value: 0 }); const final = await run.completion;
  assert.equal(final.status, 'cancelled'); assert.equal(final.lastAccepted!.result.status, 'accepted'); assert.equal(f.service.writes, 1);
  assert.equal(f.executor.query('publication-1')!.state, 'applied');
});

test('unsupported Effect bindings fail before execution and policy errors expose only static failures', async () => {
  const f = fixture();
  assert.throws(() => f.effects.register('prepare', { operation: f.operation }), /INVALID_EFFECT_COMPONENT/);
  assert.throws(() => f.effects.register('publish', { operation: f.operation, approval: f.approve }), /INVALID_EFFECT_BINDING/);
  assert.throws(() => compileWorkflow(f.definition, f.catalog));
  f.effects.register('publish', { operation() { throw new Error('PRIVATE_POLICY'); } });
  const result = await new WorkflowRuntime().start(compileWorkflow(f.definition, f.catalog), 'policy', { value: 0 }).completion;
  assert.equal(result.reason, 'EFFECT_POLICY_FAILED'); assert.ok(!JSON.stringify(result).includes('PRIVATE_POLICY')); assert.equal(f.service.writes, 0);
  const invalid = fixture(); invalid.effects.register('publish', { operation: () => ({ target: '', key: 'key' }) });
  const malformed = await new WorkflowRuntime().start(compileWorkflow(invalid.definition, invalid.catalog), 'invalid', { value: 0 }).completion;
  assert.equal(malformed.reason, 'INVALID_EFFECT_REQUEST'); assert.equal(invalid.service.writes, 0);
});
