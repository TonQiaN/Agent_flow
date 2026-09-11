import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComponentDefinition, JsonValue } from '@agentflow/domain';
import { ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import { FileArtifactStore } from '../artifacts/file-store.js';
import { FileWorkflowCatalog } from './files.js';
import { FileJsonWorkflowCatalog } from './file-json.js';
import type { FileJsonTransform } from './file-json.js';

const identity = { runId: 'run', nodeTaskId: 'transform', attemptId: 'attempt-1', attemptNumber: 1 };
const component: ComponentDefinition = { id: 'read', implementation: 'read-impl', kind: 'transform', inputContract: 'files', outcomes: { done: 'answer' } };
const cancel = { requested: () => false };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-file-json-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'answer.json'), '{"value":7}');
  const json = new ContractRegistry(); json.register('answer', { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false });
  const contracts = new FileContractRegistry(json); contracts.register('files', { rules: [{ id: 'answer', kind: 'file', match: 'answer.json', minCount: 1, maxCount: 1,
    maxBytes: 100, mediaTypes: ['application/json'], jsonContract: 'answer' }], maxFiles: 1, maxTotalBytes: 100, unmatched: 'reject' });
  const store = new FileArtifactStore(join(root, 'store'), contracts), files = new FileWorkflowCatalog(contracts, store, join(root, 'nodes'));
  const bridge = new FileJsonWorkflowCatalog(files, json, join(root, 'transforms')), input = await files.prepareInput('run', source, 'files');
  return { root, source, json, contracts, store, files, bridge, input };
}
test('file-to-JSON conversion snapshots source authority and result, records acceptance after cleanup', async t => {
  const f = await fixture(t), original = f.files.inspect(f.input, 'run').manifest, output = { value: 7 };
  f.bridge.register(component, async ctx => {
    assert.deepEqual(JSON.parse(await readFile(join(ctx.inputPath, 'answer.json'), 'utf8')), output);
    assert.deepEqual(ctx.source.manifest, original);
    (ctx.source.manifest.files[0] as { sha256: string }).sha256 = 'forged';
    (ctx.source.reference as { fileRef: string }).fileRef = 'forged';
    await writeFile(join(ctx.inputPath, 'answer.json'), '{"value":99}'); return { outcome: 'done', output };
  });
  const result = await f.bridge.execute(component, f.input, identity, cancel); assert.equal(result.status, 'accepted');
  output.value = 100; assert.ok(f.bridge.matches(identity, { value: 7 })); assert.ok(!f.bridge.matches({ ...identity, runId: 'other' }, { value: 7 }));
  const receipt = f.bridge.receipt(identity); assert.deepEqual(receipt.input, original); assert.deepEqual(receipt.predecessor, f.input);
  (receipt.output as { value: number }).value = 0; assert.deepEqual(f.bridge.receipt(identity).output, { value: 7 });
  assert.deepEqual(await readdir(join(f.root, 'transforms')), []); assert.equal(await readFile(join(f.source, 'answer.json'), 'utf8'), '{"value":7}');
  await assert.rejects(f.bridge.execute(component, f.input, identity, cancel), /INVALID_TRANSFORM_ATTEMPT/);
  await f.files.release(f.input, 'run'); assert.deepEqual(await readdir(join(f.root, 'store')), []);
});

test('file-to-JSON rejects forged, foreign, released and digest-changed inputs before calling trusted code', async t => {
  const f = await fixture(t); let calls = 0;
  f.bridge.register(component, async () => { calls++; return { outcome: 'done', output: { value: 7 } }; });
  for (const [name, input, runId] of [['forged', { fileRef: 'forged' }, 'run'], ['foreign', f.input, 'other']] as const) {
    const i = { ...identity, runId, nodeTaskId: name }, result = await f.bridge.execute(component, input, i, cancel);
    assert.equal(result.status, 'failed'); assert.throws(() => f.bridge.receipt(i), /UNKNOWN_FILE_JSON_RECEIPT/); await f.bridge.cleanup(i);
  }
  // Corrupt the private stored bytes, retaining the engine manifest: materialization must rehash.
  const [directory] = await readdir(join(f.root, 'store')); assert.ok(directory);
  await writeFile(join(f.root, 'store', directory, 'answer.json'), '{"value":8}');
  const corrupt = { ...identity, nodeTaskId: 'corrupt' }, result = await f.bridge.execute(component, f.input, corrupt, cancel);
  assert.equal(result.status, 'failed'); if (result.status !== 'failed') throw new Error(); assert.ok(result.issues.length); await f.bridge.cleanup(corrupt);
  await f.files.release(f.input, 'run'); const released = { ...identity, nodeTaskId: 'released' };
  assert.equal((await f.bridge.execute(component, f.input, released, cancel)).status, 'failed'); await f.bridge.cleanup(released); assert.equal(calls, 0);
});

test('file-to-JSON rejects invalid JSON, contracts, outcomes and exceptions; failed attempts remain failed after cleanup', async t => {
  const f = await fixture(t);
  const cases: [string, FileJsonTransform][] = [
    ['schema', async () => ({ outcome: 'done', output: { value: 'wrong' } })],
    ['outcome', async () => ({ outcome: 'invented', output: { value: 7 } })],
    ['extra', async () => ({ outcome: 'done', output: { value: 7 }, extra: true })],
    ['undefined', async () => ({ outcome: 'done', output: { value: undefined } as unknown as JsonValue })],
    ['throws', async () => { throw new Error('PRIVATE_PATH_AND_CONFIG'); }],
  ];
  for (const [name, fn] of cases) {
    const c = { ...component, id: name }, i = { ...identity, nodeTaskId: name }; f.bridge.register(c, fn);
    const result = await f.bridge.execute(c, f.input, i, cancel); assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.throws(() => f.bridge.receipt(i), /UNKNOWN_FILE_JSON_RECEIPT/); await f.bridge.cleanup(i);
    assert.deepEqual(await readdir(join(f.root, 'transforms')), []); assert.throws(() => f.bridge.receipt(i), /UNKNOWN_FILE_JSON_RECEIPT/);
  }
  await f.files.release(f.input, 'run');
});

test('file-to-JSON reserves active attempts and refuses cleanup while trusted code is running', async t => {
  const f = await fixture(t); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
  f.bridge.register(component, async () => { enter(); await finished; return { outcome: 'done', output: { value: 7 } }; });
  const active = f.bridge.execute(component, f.input, identity, cancel); await entered;
  try { await assert.rejects(f.bridge.cleanup(identity), /INVALID_TRANSFORM_CLEANUP/); await assert.rejects(f.bridge.execute(component, f.input, identity, cancel), /INVALID_TRANSFORM_ATTEMPT/); }
  finally { finish(); }
  assert.equal((await active).status, 'accepted'); await f.files.release(f.input, 'run');
});

test('file-to-JSON cancellation prevents invocation; preflight rejects contract namespace ambiguity and non-Transform kinds', async t => {
  const f = await fixture(t); let calls = 0;
  f.bridge.register(component, async () => { calls++; return { outcome: 'done', output: { value: 7 } }; });
  const result = await f.bridge.execute(component, f.input, identity, { requested: () => true }); assert.equal(result.status, 'failed');
  assert.equal(calls, 0); await f.bridge.cleanup(identity); await assert.rejects(readFile(join(f.root, 'transforms')), { code: 'ENOENT' });
  const fn: FileJsonTransform = async () => ({ outcome: 'done', output: { value: 7 } });
  assert.throws(() => f.bridge.register({ ...component, id: 'gate', kind: 'gate' }, fn), /INVALID_FILE_JSON_TRANSFORM/);
  f.json.register('files', { type: 'object' });
  assert.throws(() => f.bridge.register({ ...component, id: 'ambiguous', outcomes: { done: 'files' } }, fn), /AMBIGUOUS_TRANSFORM_CONTRACT/);
  await f.files.release(f.input, 'run');
});
