import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, FileContractRegistry,
  compileWorkflow, snapshotWorkflowStructure, assertWorkflowStructureMatches } from '@agentflow/engine';
import type { WorkflowDefinition, WorkflowNodeExecutor, WorkflowContractDefinition, FileContract } from '@agentflow/engine';
import { FileWorkflowCatalog } from './files.js';
import { FileJsonWorkflowCatalog } from './file-json.js';
import { FileArtifactStore } from '../artifacts/file-store.js';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
const definition = (): WorkflowDefinition => ({ id: 'flow', start: 'a', input: { kind: 'json', id: 'number' },
  outcomes: { done: { kind: 'json', id: 'number' } }, maxSteps: 2, nodes: { a: { component: 'a' }, b: { component: 'b' } },
  routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] });
function fixture(schema: unknown = { type: 'integer', minimum: 0 }) {
  const contracts = new ContractRegistry(); contracts.register('number', schema);
  const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
  for (const id of ['a', 'b']) {
    components.register({ id, kind: 'transform', inputContract: 'number', outcomes: { ok: 'number' }, implementation: id });
    functions.register(id, input => ({ outcome: 'ok', output: input }));
  }
  return { contracts, catalog: new JsonFunctionWorkflowCatalog(contracts, components, functions) };
}

test('registry exports actual independent schemas, including booleans; failed registration leaves no definition', () => {
  const registry = new ContractRegistry(), schema = { type: 'integer', minimum: 0 }; registry.register('n', schema);
  schema.minimum = 10; (registry.definition('n') as any).minimum = 20;
  assert.deepEqual(registry.definition('n'), { type: 'integer', minimum: 0 }); assert.equal(registry.check('n', 1).valid, true);
  for (const value of [false, true]) { registry.register(String(value), value); assert.equal(registry.definition(String(value)), value); }
  assert.throws(() => registry.register('bad', { type: 'unknown' }), /INVALID_CONTRACT_SCHEMA/);
  assert.throws(() => registry.definition('bad'), /UNKNOWN_CONTRACT/);
});

test('compiled structure retains actual contract definitions and rejects forged executable authority', () => {
  const f = fixture(), source = definition(), plan = compileWorkflow(source, f.catalog);
  f.catalog.contractDefinition = () => { throw new Error('replaced'); };
  (source.nodes as any).a.component = 'other';
  const first = snapshotWorkflowStructure(plan);
  assert.deepEqual(first.contracts, [{ kind: 'json', id: 'number', schema: { type: 'integer', minimum: 0 } }]);
  (first.components as any).a.id = 'forged'; (first.contracts[0] as any).schema.minimum = 99;
  const next = snapshotWorkflowStructure(plan); assert.equal(next.components.a!.id, 'a');
  assert.equal((next.contracts[0] as any).schema.minimum, 0);
  assert.throws(() => snapshotWorkflowStructure({ definition: plan.definition }), /UNTRUSTED_WORKFLOW_PLAN/);
});

test('SQLite structural snapshot matches a newly compiled installation and blocks same-ID definition changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-structure-')); t.after(() => rm(root, { recursive: true, force: true }));
  let store = await SqliteRunRecordStore.open(root);
  const first = compileWorkflow(definition(), fixture().catalog), saved = snapshotWorkflowStructure(first);
  await store.create('run', JSON.parse(JSON.stringify(saved))); store.close();
  store = await SqliteRunRecordStore.open(root); t.after(() => store.close()); const loaded = (await store.read('run'))!.content;
  assertWorkflowStructureMatches(compileWorkflow(definition(), fixture({ minimum: 0, type: 'integer' }).catalog), loaded);
  assert.throws(() => assertWorkflowStructureMatches(compileWorkflow(definition(), fixture({ type: 'integer', minimum: 1 }).catalog), loaded), /WORKFLOW_STRUCTURE_MISMATCH/);
  const changed = definition() as any; changed.maxSteps = 3;
  assert.throws(() => assertWorkflowStructureMatches(compileWorkflow(changed, fixture().catalog), loaded), /WORKFLOW_STRUCTURE_MISMATCH/);
  for (const mutate of [(v: any) => { v.version = 2; }, (v: any) => { v.extra = true; }, (v: any) => { v.components.a.implementation = 'changed'; }]) {
    const copy = structuredClone(loaded); mutate(copy); assert.throws(() => assertWorkflowStructureMatches(first, copy), /WORKFLOW_STRUCTURE_MISMATCH/);
  }
  let evaluated = false;
  assert.throws(() => assertWorkflowStructureMatches(first, { get version() { evaluated = true; return 1; } }), /INVALID_WORKFLOW_STRUCTURE_SNAPSHOT/);
  assert.equal(evaluated, false);
});

test('same contract ID across catalogs must represent the same definition when exported', () => {
  const a = fixture(), b = fixture({ type: 'integer', minimum: 100 });
  const plan = compileWorkflow(definition(), { resolve: id => (id === 'a' ? a : b).catalog.resolve(id) });
  assert.throws(() => snapshotWorkflowStructure(plan), /WORKFLOW_CONTRACT_DEFINITION_MISMATCH/);
});

test('legacy executors still compile but cannot provide incomplete persistent structure evidence', () => {
  const f = fixture(), executor: WorkflowNodeExecutor = { validate: c => f.catalog.validate(c), contract: id => f.catalog.contract(id),
    check: (id, value) => f.catalog.check(id, value), execute: (...args) => f.catalog.execute(...args) };
  const plan = compileWorkflow(definition(), { resolve: id => ({ component: f.catalog.resolve(id).component, executor }) });
  assert.throws(() => snapshotWorkflowStructure(plan), /WORKFLOW_CONTRACT_DEFINITION_UNAVAILABLE/);
  for (const value of [
    { kind: 'json', id: 'other', schema: true }, { kind: 'json', id: 'number', schema: { $ref: 'https://example.invalid/schema' } },
    { kind: 'json', id: 'number', schema: true, extra: true }
  ]) {
    executor.contractDefinition = () => value as WorkflowContractDefinition;
    const bad = compileWorkflow(definition(), { resolve: id => ({ component: f.catalog.resolve(id).component, executor }) });
    assert.throws(() => snapshotWorkflowStructure(bad), /INVALID_WORKFLOW_CONTRACT_DEFINITION/);
  }
});

const fileDefinition: FileContract = { rules: [{ id: 'answer', kind: 'file', match: 'answer.json', minCount: 1, maxCount: 1,
  mediaTypes: ['application/json'], maxBytes: 1024, jsonContract: 'number' }], maxFiles: 1, maxTotalBytes: 1024, unmatched: 'reject' };
function fileCatalog(schema: unknown, root: string) {
  const json = new ContractRegistry(); json.register('number', schema); json.register('unused', { type: 'string' });
  const contracts = new FileContractRegistry(json); contracts.register('files', fileDefinition);
  const files = new FileWorkflowCatalog(contracts, new FileArtifactStore(join(root, 'snapshots'), contracts), join(root, 'work'));
  files.registerFunction({ id: 'a', kind: 'transform', implementation: 'a', inputContract: 'files', outcomes: { ok: 'files' } }, async () => ({ outcome: 'ok' }));
  const transform = new FileJsonWorkflowCatalog(files, json, join(root, 'transform'));
  transform.register({ id: 'b', kind: 'transform', implementation: 'b', inputContract: 'files', outcomes: { ok: 'number' } }, async () => ({ outcome: 'ok', output: 1 }));
  return { files, transform };
}
const fileFlow = (): WorkflowDefinition => ({ ...definition(), input: { kind: 'files', id: 'files' } });

test('file and mixed catalogs snapshot actual nested JSON contracts and omit unrelated definitions', () => {
  const f = fileCatalog({ type: 'integer' }, '/unused/structure');
  const plan = compileWorkflow(fileFlow(), { resolve: id => id === 'a' ? f.files.resolve(id) : f.transform.resolve(id) });
  const saved = snapshotWorkflowStructure(plan);
  assert.deepEqual(saved.contracts, [{ kind: 'files', id: 'files', definition: fileDefinition }, { kind: 'json', id: 'number', schema: { type: 'integer' } }]);
  const changed = fileCatalog({ type: 'integer', minimum: 3 }, '/unused/changed');
  const other = compileWorkflow(fileFlow(), { resolve: id => id === 'a' ? changed.files.resolve(id) : changed.transform.resolve(id) });
  assert.throws(() => assertWorkflowStructureMatches(other, saved), /WORKFLOW_STRUCTURE_MISMATCH/);
});

test('nested JSON definitions cannot disagree between separate file bindings or smuggle unused contracts', () => {
  const a = fileCatalog({ type: 'integer' }, '/unused/a'), b = fileCatalog({ type: 'integer', minimum: 1 }, '/unused/b');
  const plan = compileWorkflow(fileFlow(), { resolve: id => id === 'a' ? a.files.resolve(id) : b.transform.resolve(id) });
  assert.throws(() => snapshotWorkflowStructure(plan), /WORKFLOW_CONTRACT_DEFINITION_MISMATCH/);
  const describe = a.files.contractDefinition.bind(a.files);
  a.files.contractDefinition = id => { const d = describe(id); if (d.kind === 'files') return { ...d, jsonContracts: { ...d.jsonContracts, extra: true } }; return d; };
  const bad = compileWorkflow(fileFlow(), { resolve: id => id === 'a' ? a.files.resolve(id) : a.transform.resolve(id) });
  assert.throws(() => snapshotWorkflowStructure(bad), /INVALID_WORKFLOW_CONTRACT_DEFINITION/);
});
