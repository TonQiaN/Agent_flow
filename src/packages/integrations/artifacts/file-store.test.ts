import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import type { FileContract } from '@agentflow/engine';
import { FileArtifactStore, ArtifactError } from './file-store.js';

const definition: FileContract = { rules: [{ id: 'bundle', kind: 'tree', match: 'bundle', minCount: 1, maxCount: 1,
  minFiles: 1, maxFiles: 5, maxBytes: 1024, mediaTypes: ['application/json'], jsonContract: 'json' }], maxFiles: 10, maxTotalBytes: 4096, unmatched: 'reject' };

test('host snapshot budget supports full-resolution bundles while preserving default and contract limits', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-large-artifacts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(join(source, 'bundle'), { recursive: true });
  for (let i = 0; i < 5; i++) { const file = await open(join(source, 'bundle', `${i}.bin`), 'wx'); try { await file.truncate(54 * 1024 ** 2); } finally { await file.close(); } }
  const contracts = new FileContractRegistry(new ContractRegistry());
  const large = { rules: [{ id: 'data', kind: 'tree' as const, match: 'bundle', minCount: 1, maxCount: 1, minFiles: 5, maxFiles: 5, maxBytes: 300 * 1024 ** 2, mediaTypes: ['application/octet-stream'] }], maxFiles: 5, maxTotalBytes: 300 * 1024 ** 2, unmatched: 'reject' as const };
  contracts.register('large', large); contracts.register('small', { ...large, maxTotalBytes: 256 * 1024 ** 2 });
  const defaults = new FileArtifactStore(join(root, 'default'), contracts);
  await assert.rejects(defaults.capture(source, 'large'), /INVALID_FILE/);
  assert.deepEqual(await readdir(join(root, 'default')), []);
  const options = { maxTotalBytes: 300 * 1024 ** 2 }, store = new FileArtifactStore(join(root, 'large'), contracts, options); options.maxTotalBytes = 1;
  const captured = await store.capture(source, 'large');
  assert.equal(captured.files.reduce((sum, file) => sum + file.bytes, 0), 270 * 1024 ** 2);
  const receiving = new FileArtifactStore(join(root, 'receiving'), contracts, { maxTotalBytes: 300 * 1024 ** 2 });
  const direct = await receiving.captureMaterialized({ materialize: destination => store.materialize(captured.id, destination) }, 'large');
  assert.deepEqual(direct.files, captured.files);
  await assert.rejects(store.capture(source, 'small'), /INVALID_FILE/);
  await store.release(captured.id); await receiving.release(direct.id);
  assert.deepEqual(await readdir(join(root, 'large')), []); assert.deepEqual(await readdir(join(root, 'receiving')), []);
  for (const maxTotalBytes of [0, NaN, 1024 ** 3 + 1]) assert.throws(() => new FileArtifactStore(join(root, 'invalid'), contracts, { maxTotalBytes }), /INVALID_STORE_BYTE_BUDGET/);
});
async function fixture(t: { after(fn: () => Promise<void>): void }, contract: FileContract = definition) {
  const root = await mkdtemp(join(tmpdir(), 'af-artifacts-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'outputs'); await mkdir(join(source, 'bundle', 'nested'), { recursive: true });
  await writeFile(join(source, 'bundle', 'nested', 'answer.json'), '{"sum":6}');
  const json = new ContractRegistry(); json.register('json', { type: 'object', properties: { sum: { const: 6, type: 'integer' } }, required: ['sum'], additionalProperties: false });
  const contracts = new FileContractRegistry(json); contracts.register('files', contract);
  const store = new FileArtifactStore(join(root, 'store'), contracts);
  return { root, source, store };
}

test('captured trees are independent of source, returned manifests and each writable downstream copy', async t => {
  const { root, source, store } = await fixture(t); const manifest = await store.capture(source, 'files');
  assert.deepEqual(manifest.directories, ['bundle', 'bundle/nested']); assert.equal(manifest.files[0]!.rule, 'bundle');
  assert.match(manifest.files[0]!.sha256, /^[a-f0-9]{64}$/);
  (manifest.files[0] as { sha256: string }).sha256 = 'forged';
  await writeFile(join(source, 'bundle/nested/answer.json'), 'changed source');
  await store.materialize(manifest.id, join(root, 'first')); await store.materialize(manifest.id, join(root, 'second'));
  await writeFile(join(root, 'first/bundle/nested/answer.json'), 'changed downstream');
  assert.equal(await readFile(join(root, 'second/bundle/nested/answer.json'), 'utf8'), '{"sum":6}');
  assert.notEqual((await stat(join(root, 'first/bundle/nested/answer.json'))).ino, (await stat(join(root, 'second/bundle/nested/answer.json'))).ino);
  await store.release(manifest.id); await store.release(manifest.id);
  await assert.rejects(store.materialize(manifest.id, join(root, 'third')), /UNKNOWN_SNAPSHOT/);
});

test('missing, unclaimed, oversized and malformed JSON files never publish a snapshot', async t => {
  const { root, source, store } = await fixture(t);
  for (const value of ['not JSON', '{"sum":7}', ' '.repeat(2048)]) {
    await writeFile(join(source, 'bundle/nested/answer.json'), value);
    await assert.rejects(store.capture(source, 'files'), ArtifactError);
    assert.deepEqual(await readdir(join(root, 'store')), []);
  }
  await writeFile(join(source, 'bundle/nested/answer.json'), '{"sum":6}');
  await writeFile(join(source, 'unclaimed.txt'), 'secret payload');
  await assert.rejects(store.capture(source, 'files'), error => error instanceof ArtifactError && error.issues.some(issue => issue.path === 'unclaimed.txt' && issue.code === 'UNMATCHED_ENTRY'));
  await rm(join(source, 'unclaimed.txt')); await rm(join(source, 'bundle/nested/answer.json'));
  await assert.rejects(store.capture(source, 'files'), ArtifactError);
});

test('symbolic links, hard links, root links and FIFOs are refused without following or blocking', async t => {
  const { root, source, store } = await fixture(t); const path = join(source, 'bundle/unsafe');
  const outside = join(root, 'outside'); await writeFile(outside, 'PRIVATE_CONTENT');
  for (const make of [() => symlink(outside, path), () => link(outside, path), async () => { execFileSync('mkfifo', [path]); }]) {
    await make(); await assert.rejects(store.capture(source, 'files'), /INVALID_FILE/); await rm(path);
    assert.equal(await readFile(outside, 'utf8'), 'PRIVATE_CONTENT');
  }
  await symlink(source, join(root, 'linked-source')); await assert.rejects(store.capture(join(root, 'linked-source'), 'files'), /INVALID_DIRECTORY/);
  await symlink(root, path); await assert.rejects(store.capture(source, 'files'), /INVALID_FILE/);
});

test('handoff rechecks hashes and links, removes its partial copy and preserves an existing destination', async t => {
  const { root, source, store } = await fixture(t); const manifest = await store.capture(source, 'files');
  const snapshot = join(root, 'store', (await readdir(join(root, 'store')))[0]!, 'bundle/nested/answer.json');
  await writeFile(snapshot, '{"sum":7}');
  await assert.rejects(store.materialize(manifest.id, join(root, 'delivery')), /ARTIFACT_INTEGRITY_MISMATCH/);
  await assert.rejects(stat(join(root, 'delivery')), { code: 'ENOENT' });
  await rm(snapshot); await symlink(join(source, 'bundle/nested/answer.json'), snapshot);
  await assert.rejects(store.materialize(manifest.id, join(root, 'delivery')), /INVALID_FILE/);
  await mkdir(join(root, 'existing')); await writeFile(join(root, 'existing/keep'), 'untouched');
  await assert.rejects(store.materialize(manifest.id, join(root, 'existing')), ArtifactError);
  assert.equal(await readFile(join(root, 'existing/keep'), 'utf8'), 'untouched');
});

test('media detection checks PDF/image signatures and JSON syntax, independently of a claimed filename', async t => {
  const { jsonContract: _schema, ...rule } = definition.rules[0]!;
  const def: FileContract = { ...definition, rules: [{ ...rule, mediaTypes: ['application/pdf', 'image/png', 'image/jpeg'] }] };
  const { root, source, store } = await fixture(t, def); await rm(join(source, 'bundle/nested/answer.json'));
  await writeFile(join(source, 'bundle/a.bin'), '%PDF-1.7\n'); await writeFile(join(source, 'bundle/b.bin'), Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFile(join(source, 'bundle/c.bin'), Buffer.from([255,216,255]));
  const result = await store.capture(source, 'files'); assert.deepEqual(result.files.map(file => file.mediaType), ['application/pdf', 'image/png', 'image/jpeg']);
  await writeFile(join(source, 'bundle/fake.pdf'), 'not PDF'); await assert.rejects(store.capture(source, 'files'), /FILE_CONTRACT_VIOLATION/);
  assert.equal((await stat(join(root, 'store'))).mode & 0o777, 0o700);
});

test('unclaimed empty helper directories are omitted, while declared empty trees and unknown contents remain meaningful', async t => {
  const { root, source, store } = await fixture(t);
  for (const path of ['.agents', '.codex', '.git', 'arbitrary/empty']) await mkdir(join(source, path), { recursive: true });
  const result = await store.capture(source, 'files'); assert.deepEqual(result.directories, ['bundle', 'bundle/nested']);
  await store.materialize(result.id, join(root, 'accepted')); assert.deepEqual(await readdir(join(root, 'accepted')), ['bundle']);
  await writeFile(join(source, '.agents/hidden.txt'), 'uncontracted');
  await assert.rejects(store.capture(source, 'files'), error => error instanceof ArtifactError && error.issues.some(issue => issue.path === '.agents/hidden.txt'));
  const empty = await fixture(t, { ...definition, rules: [{ ...definition.rules[0]!, minFiles: 0 }] });
  await rm(join(empty.source, 'bundle/nested/answer.json'));
  const declared = await empty.store.capture(empty.source, 'files'); assert.deepEqual(declared.directories, ['bundle', 'bundle/nested']);
});

test('snapshot inspection only describes entries actually owned by this store and returns copies', async t => {
  const f = await fixture(t), manifest = await f.store.capture(f.source, 'files');
  const view = await f.store.inspect(manifest.id); (view.files[0] as { sha256: string }).sha256 = 'changed';
  assert.deepEqual(await f.store.inspect(manifest.id), manifest);
  const other = new FileArtifactStore(join(f.root, 'other'), f.store.contracts);
  await assert.rejects(other.inspect(manifest.id), /UNKNOWN_SNAPSHOT/);
  await f.store.release(manifest.id); await assert.rejects(f.store.inspect(manifest.id), /UNKNOWN_SNAPSHOT/);
});
