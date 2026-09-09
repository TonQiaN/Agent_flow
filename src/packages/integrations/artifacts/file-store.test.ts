import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import type { FileContract } from '@agentflow/engine';
import { FileArtifactStore, ArtifactError } from './file-store.js';

const definition: FileContract = { rules: [{ id: 'bundle', kind: 'tree', match: 'bundle', minCount: 1, maxCount: 1,
  minFiles: 1, maxFiles: 5, maxBytes: 1024, mediaTypes: ['application/json'], jsonContract: 'json' }], maxFiles: 10, maxTotalBytes: 4096, unmatched: 'reject' };
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
