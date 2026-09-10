import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@agentflow/domain';
import { ContractRegistry } from '../contracts/registry.js';
import { ComponentRegistry, FunctionRegistry } from '../components/registry.js';
import type { ComponentFunction } from '../components/registry.js';
import { compileWorkflow, WorkflowDefinitionError } from './compiler.js';
import { JsonFunctionWorkflowCatalog } from './functions.js';
import { WorkflowRuntime } from './runtime.js';
import type { CompiledWorkflow, WorkflowCatalog, WorkflowDefinition, WorkflowNodeExecutor, WorkflowNodeResult } from './types.js';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const def = (): WorkflowDefinition => ({ id: 'chain', start: 'first', input: { kind: 'json', id: 'number' }, outcomes: { done: { kind: 'json', id: 'number' } }, maxSteps: 10,
  nodes: { first: { component: 'first' }, second: { component: 'second' } }, routes: [{ from: 'first', outcome: 'ok', to: { node: 'second' } }, { from: 'second', outcome: 'ok', to: { end: 'done' } }] });
function fixture(first: ComponentFunction = n => ({ outcome: 'ok', output: (n as number) + 1 }), second: ComponentFunction = n => ({ outcome: 'ok', output: (n as number) * 2 })) {
  const contracts = new ContractRegistry(); contracts.register('number', { type: 'integer' }); contracts.register('object', { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false });
  const components = new ComponentRegistry(contracts); const functions = new FunctionRegistry();
  for (const [id, fn] of [['first', first], ['second', second]] as const) {
    components.register({ id, kind: 'transform', inputContract: 'number', outcomes: { ok: 'number' }, implementation: id }); functions.register(id, fn);
  }
  const catalog = new JsonFunctionWorkflowCatalog(contracts, components, functions); return { contracts, components, functions, catalog };
}
function altered(change: (draft: Mutable<WorkflowDefinition>) => void): WorkflowDefinition { const draft = structuredClone(def()) as Mutable<WorkflowDefinition>; change(draft); return draft; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('compiler rejects invalid references, routes, contracts, reachability and bounds before any execution', () => {
  const f = fixture();
  const cases: [string, (d: Mutable<WorkflowDefinition>) => void][] = [
    ['UNKNOWN_START_NODE', d => { d.start = 'missing'; }],
    ['INVALID_WORKFLOW_BINDING', d => { d.nodes['first']!.component = 'missing'; }],
    ['WORKFLOW_INPUT_MISMATCH', d => { d.input.kind = 'files'; }],
    ['WORKFLOW_OUTPUT_MISMATCH', d => { d.outcomes['done']!.id = 'object'; }],
    ['UNKNOWN_ROUTE_SOURCE', d => { d.routes[0]!.from = 'missing'; }],
    ['UNKNOWN_ROUTE_OUTCOME', d => { d.routes[0]!.outcome = 'missing'; }],
    ['DUPLICATE_WORKFLOW_ROUTE', d => { d.routes.push(structuredClone(d.routes[0]!)); }],
    ['UNKNOWN_TARGET_NODE', d => { d.routes[0]!.to = { node: 'missing' }; }],
    ['UNKNOWN_WORKFLOW_OUTCOME', d => { d.routes[1]!.to = { end: 'missing' }; }],
    ['MISSING_WORKFLOW_ROUTE', d => { d.routes.pop(); }],
    ['NO_WORKFLOW_TERMINAL', d => { d.routes[1]!.to = { node: 'first' }; }],
    ['UNUSED_WORKFLOW_OUTCOME', d => { d.outcomes['unused'] = { kind: 'json', id: 'number' }; }],
    ['UNREACHABLE_WORKFLOW_NODE', d => { d.nodes['third'] = { component: 'first' }; d.routes.push({ from: 'third', outcome: 'ok', to: { end: 'done' } }); }],
    ['INVALID_WORKFLOW', d => { d.maxSteps = 0; }],
    ['INVALID_WORKFLOW', d => { d.maxSteps = 10_001; }],
    ['INVALID_ROUTE_LIMIT', d => { d.routes[0]!.limit = { max: -1, exhausted: { end: 'done' } }; }],
    ['UNKNOWN_TARGET_NODE', d => { d.routes[0]!.limit = { max: 1, exhausted: { node: 'missing' } }; }],
    ['INVALID_WORKFLOW_NODE', d => { d.nodes['bad/key'] = { component: 'first' }; }],
  ];
  for (const [code, change] of cases) assert.throws(() => compileWorkflow(altered(change), f.catalog), (error: unknown) => error instanceof WorkflowDefinitionError && error.code === code && error.path.startsWith('/'), code);
  assert.throws(() => compileWorkflow({ ...def(), undocumented: true } as WorkflowDefinition, f.catalog), /INVALID_WORKFLOW/);
  assert.throws(() => compileWorkflow(altered(d => { d.routes[0]!.to = { node: 'second', end: 'done' } as { node: string }; }), f.catalog), /INVALID_DESTINATION/);
  f.components.register({ id: 'agent', kind: 'agent', inputContract: 'number', outcomes: { ok: 'number' }, implementation: 'first' });
  assert.throws(() => compileWorkflow(altered(d => { d.nodes['first']!.component = 'agent'; }), f.catalog), /INVALID_WORKFLOW_BINDING/);
});

test('contract category participates in edge matching even when IDs are identical', () => {
  const f = fixture(); const catalog: WorkflowCatalog = { resolve(id) {
    const resolved = f.catalog.resolve(id); if (id === 'first') return resolved;
    const executor: WorkflowNodeExecutor = { validate: c => f.catalog.validate(c), contract: id => ({ kind: 'files', id }), check: () => [], execute: (...args) => f.catalog.execute(...args) };
    return { component: resolved.component, executor };
  } };
  assert.throws(() => compileWorkflow(def(), catalog), /WORKFLOW_CONTRACT_MISMATCH/);
});

test('compiled authority, definitions and captured executor methods are independent of caller mutation', async () => {
  const f = fixture(); const definition = def() as Mutable<WorkflowDefinition>; const plan = compileWorkflow(definition, f.catalog);
  definition.routes[0]!.to = { end: 'done' }; (plan.definition as Mutable<WorkflowDefinition>).routes[0]!.to = { end: 'done' };
  f.catalog.execute = async () => { throw new Error('replaced after compile'); };
  const runtime = new WorkflowRuntime(); const result = await runtime.start(plan, 'run', 2).completion;
  assert.equal(result.status, 'succeeded'); assert.equal(result.outcome, 'done'); assert.equal(result.steps.length, 2);
  assert.equal(result.lastAccepted!.result.status, 'accepted'); if (result.lastAccepted!.result.status === 'accepted') assert.equal(result.lastAccepted!.result.output, 6);
  assert.deepEqual(result.steps.map(step => step.result.identity.nodeTaskId), ['task-1', 'task-2']);
  assert.throws(() => runtime.start({ definition: plan.definition } as CompiledWorkflow, 'forged', 2), /UNTRUSTED_WORKFLOW_PLAN/);
  assert.throws(() => runtime.start(plan, 'run', 2), /DUPLICATE_WORKFLOW_RUN/);
  assert.throws(() => runtime.query('absent'), /UNKNOWN_WORKFLOW_RUN/);
  assert.equal(runtime.cancel('run'), false);
});

function repair(max: number, stopAt = 2, alternate = false) {
  const contracts = new ContractRegistry(); contracts.register('number', { type: 'integer' });
  const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
  for (const [id, kind, outcomes, fn] of [
    ['check', 'gate', { accepted: 'number', repair: 'number' }, (n: JsonValue) => ({ outcome: (n as number) >= stopAt ? 'accepted' : 'repair', output: n })],
    ['revise', 'transform', { fixed: 'number' }, (n: JsonValue) => ({ outcome: 'fixed', output: (n as number) + 1 })],
    ['escalate', 'transform', { escalated: 'number' }, (n: JsonValue) => ({ outcome: 'escalated', output: n })],
  ] as const) { components.register({ id, kind, inputContract: 'number', outcomes, implementation: id }); functions.register(id, fn); }
  const definition: WorkflowDefinition = { id: 'repair', start: 'review', input: { kind: 'json', id: 'number' }, outcomes: { accepted: { kind: 'json', id: 'number' }, rejected: { kind: 'json', id: 'number' } }, maxSteps: 20,
    nodes: { review: { component: 'check' }, fixer: { component: 'revise' }, ...(alternate ? { escalation: { component: 'escalate' } } : {}) },
    routes: [{ from: 'review', outcome: 'accepted', to: { end: 'accepted' } }, { from: 'review', outcome: 'repair', to: { node: 'fixer' }, limit: { max, exhausted: alternate ? { node: 'escalation' } : { end: 'rejected' } } },
      { from: 'fixer', outcome: 'fixed', to: { node: 'review' } }, ...(alternate ? [{ from: 'escalation', outcome: 'escalated', to: { end: 'rejected' } }] : [])] };
  return compileWorkflow(definition, new JsonFunctionWorkflowCatalog(contracts, components, functions));
}

test('user repair routes create distinct NodeTasks and keep counters independent across Runs', async () => {
  const runtime = new WorkflowRuntime(), plan = repair(2);
  const results = await Promise.all(['a', 'b'].map(id => runtime.start(plan, id, 0).completion));
  for (const result of results) {
    assert.equal(result.status, 'succeeded'); assert.equal(result.outcome, 'accepted'); assert.equal(result.steps.length, 5);
    assert.deepEqual(result.steps.map(step => step.node), ['review', 'fixer', 'review', 'fixer', 'review']);
    assert.equal(new Set(result.steps.map(step => step.result.identity.nodeTaskId)).size, 5);
    assert.ok(result.steps.every(step => step.result.identity.attemptNumber === 1)); assert.deepEqual(result.limits, []);
  }
});

test('route limits including zero retain original business outcomes, last result and exhaustion evidence', async () => {
  for (const max of [0, 1]) {
    const result = await new WorkflowRuntime().start(repair(max), `limit-${max}`, 0).completion;
    assert.equal(result.status, 'exhausted'); assert.equal(result.reason, 'ROUTE_LIMIT_EXCEEDED'); assert.equal(result.outcome, 'rejected'); assert.equal(result.steps.length, max * 2 + 1);
    const last = result.lastAccepted!.result; assert.equal(last.status, 'accepted'); if (last.status === 'accepted') { assert.equal(last.outcome, 'repair'); assert.equal(last.output, max); }
    assert.deepEqual(result.limits, [{ node: 'review', outcome: 'repair', step: max * 2 + 1, max }]);
  }
  const escalated = await new WorkflowRuntime().start(repair(0, 2, true), 'escalated', 0).completion;
  assert.equal(escalated.status, 'succeeded'); assert.equal(escalated.outcome, 'rejected'); assert.deepEqual(escalated.steps.map(step => step.node), ['review', 'escalation']); assert.equal(escalated.limits.length, 1);
});

test('global max steps prevents another task and preserves the previous accepted output', async () => {
  const plan = compileWorkflow({ ...def(), maxSteps: 1 }, fixture().catalog);
  const result = await new WorkflowRuntime().start(plan, 'bounded', 2).completion;
  assert.equal(result.status, 'exhausted'); assert.equal(result.reason, 'MAX_STEPS_EXCEEDED'); assert.equal(result.outcome, null); assert.equal(result.steps.length, 1);
  assert.equal(result.lastAccepted!.result.status, 'accepted');
});

test('function failure and invalid input/output never route; arbitrary exceptions remain private', async () => {
  for (const first of [() => { throw new Error('PRIVATE_SECRET'); }, () => ({ outcome: 'ok', output: 'wrong' }), () => ({ outcome: 'undeclared', output: 1 })] as ComponentFunction[]) {
    let secondCalls = 0; const f = fixture(first, n => { secondCalls++; return { outcome: 'ok', output: n }; });
    const result = await new WorkflowRuntime().start(compileWorkflow(def(), f.catalog), 'failure', 0).completion;
    assert.equal(result.status, 'failed'); assert.equal(result.outcome, null); assert.equal(secondCalls, 0); assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));
  }
  const invalid = await new WorkflowRuntime().start(compileWorkflow(def(), fixture().catalog), 'invalid', 'bad').completion;
  assert.equal(invalid.reason, 'INVALID_NODE_INPUT'); assert.equal(invalid.issues[0]!.contractId, 'number'); assert.equal(invalid.steps.length, 0);
});

test('cancel before start invokes no task; cancel during a function waits for it and prevents the next node', async () => {
  let calls = 0; const before = fixture(n => { calls++; return { outcome: 'ok', output: n }; });
  const firstHandle = new WorkflowRuntime().start(compileWorkflow(def(), before.catalog), 'before', 0); firstHandle.cancel();
  assert.equal((await firstHandle.completion).status, 'cancelled'); assert.equal(calls, 0);
  const entered = deferred<void>(), release = deferred<void>(); let next = 0;
  const during = fixture(async n => { entered.resolve(); await release.promise; return { outcome: 'ok', output: n }; }, n => { next++; return { outcome: 'ok', output: n }; });
  const handle = new WorkflowRuntime().start(compileWorkflow(def(), during.catalog), 'during', 0); await entered.promise; handle.cancel();
  assert.equal(handle.query().status, 'cancelling'); assert.equal(handle.query().currentIdentity!.nodeTaskId, 'task-1');
  release.resolve(); const result = await handle.completion;
  assert.equal(result.status, 'cancelled'); assert.equal(next, 0); assert.equal(result.lastAccepted!.result.status, 'accepted');
});

test('query and result snapshots cannot mutate running or completed state or original input', async () => {
  const f = fixture(); let produced: JsonValue = null;
  f.components.register({ id: 'object', kind: 'transform', inputContract: 'object', outcomes: { ok: 'object' }, implementation: 'object' });
  f.functions.register('object', input => { (input as { n: number }).n++; produced = input; return { outcome: 'ok', output: input }; });
  const definition: WorkflowDefinition = { ...def(), input: { kind: 'json', id: 'object' }, outcomes: { done: { kind: 'json', id: 'object' } }, nodes: { first: { component: 'object' } }, routes: [{ from: 'first', outcome: 'ok', to: { end: 'done' } }] };
  const original = { n: 1 }; const handle = new WorkflowRuntime().start(compileWorkflow(definition, f.catalog), 'copies', original); original.n = 9;
  const query = handle.query(); Object.assign(query, { cancelRequested: true });
  const result = await handle.completion; assert.equal(result.status, 'succeeded'); assert.equal(original.n, 9);
  (produced as unknown as { n: number }).n = 100; (result.steps as unknown[]).length = 0;
  const stored = handle.query(); assert.equal(stored.steps.length, 1); const last = stored.lastAccepted!.result;
  if (last.status === 'accepted') assert.deepEqual(last.output, { n: 2 });
});

test('port identity/outcome/output checks do not trust a claimed accepted status', async () => {
  const f = fixture();
  for (const variation of ['identity', 'outcome', 'output'] as const) {
    const delegate: WorkflowNodeExecutor = { validate: c => f.catalog.validate(c), contract: id => f.catalog.contract(id), check: (id, value) => f.catalog.check(id, value),
      async execute(c, _input, identity) { return { componentId: c.id, identity: variation === 'identity' ? { ...identity, attemptId: 'wrong' } : identity, status: 'accepted', outcome: variation === 'outcome' ? 'wrong' : 'ok', output: variation === 'output' ? 'bad' : 1 }; } };
    const catalog: WorkflowCatalog = { resolve: id => ({ component: f.components.get(id), executor: delegate }) };
    const result = await new WorkflowRuntime().start(compileWorkflow(def(), catalog), variation, 0).completion;
    assert.equal(result.status, 'failed'); assert.equal(result.steps.length, 0); assert.equal(result.lastAccepted, null);
  }
});

test('a port that cannot prove stop is never reported as cancellation completed', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  const executor: WorkflowNodeExecutor = { validate: c => f.catalog.validate(c), contract: id => f.catalog.contract(id), check: (id, value) => f.catalog.check(id, value),
    async execute(c, _input, identity, cancellation): Promise<WorkflowNodeResult> { entered.resolve(); await release.promise; assert.equal(cancellation.requested(), true); return { identity, componentId: c.id, status: 'failed', code: 'STOP_FAILED', stopped: false, issues: [] }; } };
  const handle = new WorkflowRuntime().start(compileWorkflow(def(), { resolve: id => ({ component: f.components.get(id), executor }) }), 'uncertain', 0);
  await entered.promise; handle.cancel(); release.resolve(); const result = await handle.completion;
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'EXECUTION_STOP_UNCONFIRMED'); assert.equal(result.cancelRequested, true); assert.equal(result.steps.length, 1);
  assert.equal(result.currentNode, 'first'); assert.equal(result.currentIdentity!.nodeTaskId, 'task-1');
});

test('unexpected executor throw keeps failure identity and never discloses its exception', async () => {
  const f = fixture(); const executor: WorkflowNodeExecutor = { validate: c => f.catalog.validate(c), contract: id => f.catalog.contract(id), check: (id, value) => f.catalog.check(id, value),
    async execute() { throw new Error('PRIVATE_DRIVER_DETAIL'); } };
  const plan = compileWorkflow(def(), { resolve: id => ({ component: f.components.get(id), executor }) });
  const result = await new WorkflowRuntime().start(plan, 'throwing', 0).completion;
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'EXECUTION_STOP_UNCONFIRMED'); assert.equal(result.currentNode, 'first'); assert.equal(result.currentIdentity!.nodeTaskId, 'task-1');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_DRIVER_DETAIL'));
});
