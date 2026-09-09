import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import type { FileContract, ArtifactArchiveReference } from '@agentflow/engine';
import { FileArtifactArchive } from './file-archive.js';
import { FileArtifactStore } from './file-store.js';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
const definition: FileContract = { rules: [{ id: 'bundle', kind: 'tree', match: 'bundle', minCount: 1, maxCount: 1,
  minFiles: 1, maxFiles: 5, maxBytes: 4096, mediaTypes: ['text/plain'] }], maxFiles: 5, maxTotalBytes: 4096, unmatched: 'reject' };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'af-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(join(source, 'bundle/nested'), { recursive: true });
  await writeFile(join(source, 'bundle/nested/answer.txt'), 'original');
  const contracts = new FileContractRegistry(new ContractRegistry()); contracts.register('files', definition);
  const path = join(root, 'archive'), archive = new FileArtifactArchive(path, contracts);
  return { root, source, path, archive, contracts };
}
const worker = fileURLToPath(new URL('../../../tests/fixtures/artifact-archive-worker.mjs', import.meta.url));
function child(args: string[]) {
  const process = fork(worker, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  process.stdout!.resume(); process.stderr!.resume();
  return { process, exited: once(process, 'exit'), message: once(process, 'message') };
}

test('Run reference restores in a new process after original and temporary snapshots are deleted', { timeout: 30000 }, async t => {
  const f = await fixture(t), ephemeral = new FileArtifactStore(join(f.root, 'temporary'), f.contracts);
  const temporary = await ephemeral.capture(f.source, 'files'), handoff = join(f.root, 'handoff');
  await ephemeral.materialize(temporary.id, handoff);
  const saved = await f.archive.capture(handoff, 'files'), dbRoot = join(f.root, 'state');
  const records = await SqliteRunRecordStore.open(dbRoot);
  await records.create('run', { output: { ...saved.reference } }); records.close();
  await ephemeral.release(temporary.id); await rm(f.source, { recursive: true }); await rm(handoff, { recursive: true });
  (saved.manifest.files[0] as { sha256: string }).sha256 = 'modified';
  const process = child([f.path, dbRoot, 'restore-run', join(f.root, 'restored')]); t.after(() => { process.process.kill(); });
  assert.deepEqual((await process.message)[0], { text: 'original' }); assert.deepEqual(await process.exited, [0, null]);
  const archive = new FileArtifactArchive(f.path, f.contracts);
  await archive.materialize(saved.reference, join(f.root, 'another'));
  await writeFile(join(f.root, 'restored/bundle/nested/answer.txt'), 'modified');
  assert.equal(await readFile(join(f.root, 'another/bundle/nested/answer.txt'), 'utf8'), 'original');
  assert.equal('release' in archive, false);
  assert.equal((await stat(join(f.path, saved.reference.id, 'manifest.json'))).mode & 0o777, 0o600);
});

for (const mode of ['before-publish', 'after-publish']) test(`SIGKILL ${mode} exposes only a complete published archive`, { timeout: 30000 }, async t => {
  const f = await fixture(t), process = child([f.path, f.source, mode]); t.after(() => { process.process.kill(); });
  const [{ reference }] = await process.message; assert.deepEqual(await process.exited, [null, 'SIGKILL']);
  const restarted = new FileArtifactArchive(f.path, f.contracts);
  if (mode === 'before-publish') {
    await assert.rejects(restarted.read(reference), { code: 'ARCHIVE_IO_ERROR' });
    assert.ok((await readdir(f.path)).some(name => name.startsWith('.publish-')));
  } else {
    await rm(f.source, { recursive: true });
    await restarted.materialize(reference, join(f.root, 'restored'));
    assert.equal(await readFile(join(f.root, 'restored/bundle/nested/answer.txt'), 'utf8'), 'original');
  }
});

test('concurrent processes publish independent durable archives without clobbering', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = child([f.path, f.source, 'capture']), b = child([f.path, f.source, 'capture']);
  t.after(() => { a.process.kill(); b.process.kill(); });
  const [[first], [second]] = await Promise.all([a.message, b.message]); await Promise.all([a.exited, b.exited]);
  assert.notEqual(first.reference.id, second.reference.id);
  assert.deepEqual(await f.archive.read(first.reference), first.manifest); assert.deepEqual(await f.archive.read(second.reference), second.manifest);
});

test('corrupted or missing data never produces a downstream directory; existing targets remain intact', async t => {
  const f = await fixture(t), saved = await f.archive.capture(f.source, 'files');
  const file = join(f.path, saved.reference.id, 'data/bundle/nested/answer.txt'), destination = join(f.root, 'out');
  await writeFile(file, 'tampered');
  await assert.rejects(f.archive.materialize(saved.reference, destination), { code: 'ARTIFACT_INTEGRITY_MISMATCH' });
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await rm(file); await assert.rejects(f.archive.materialize(saved.reference, destination));
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await mkdir(destination); await writeFile(join(destination, 'keep'), 'keep');
  await writeFile(file, 'original'); await assert.rejects(f.archive.materialize(saved.reference, destination));
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'keep');
});

test('manifest identity, digest, schema, hierarchy, bounds and references are validated before paths are used', async t => {
  const f = await fixture(t), saved = await f.archive.capture(f.source, 'files'), path = join(f.path, saved.reference.id, 'manifest.json');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('answer.txt', 'forged.txt'));
  await assert.rejects(f.archive.read(saved.reference), { code: 'ARCHIVE_INTEGRITY_MISMATCH' });
  for (const mutate of [
    (v: any) => { v.version = 2; }, (v: any) => { v.manifest.id = 'other'; },
    (v: any) => { v.manifest.directories = []; }, (v: any) => { v.manifest.files[0].path = '../outside'; },
    (v: any) => { v.manifest.files.push(v.manifest.files[0]); }, (v: any) => { v.manifest.files[0].bytes = -1; },
    (v: any) => { v.manifest.files[0].sha256 = 'bad'; }, (v: any) => { v.manifest.files[0].bytes = 65 * 1024 * 1024; }
  ]) {
    const value = JSON.parse(original); mutate(value); const text = JSON.stringify(value); await writeFile(path, text);
    await assert.rejects(f.archive.read({ id: saved.reference.id, sha256: createHash('sha256').update(text).digest('hex') }), { code: 'INVALID_ARCHIVE_MANIFEST' });
  }
  let evaluated = false;
  await assert.rejects(f.archive.read({ get id() { evaluated = true; return saved.reference.id; }, sha256: saved.reference.sha256 }), { code: 'INVALID_ARCHIVE_REFERENCE' });
  assert.equal(evaluated, false);
  for (const ref of [{ id: '../outside', sha256: saved.reference.sha256 }, { ...saved.reference, extra: true }]) await assert.rejects(f.archive.read(ref as ArtifactArchiveReference), { code: 'INVALID_ARCHIVE_REFERENCE' });
  await writeFile(path, ' '.repeat(16 * 1024 * 1024 + 1)); await assert.rejects(f.archive.read(saved.reference), { code: 'UNSAFE_ARCHIVE_MANIFEST' });
});

test('private archive paths reject symlinks, hard links and permission changes', async t => {
  const f = await fixture(t), saved = await f.archive.capture(f.source, 'files');
  const dir = join(f.path, saved.reference.id), metadata = join(dir, 'manifest.json'), original = await readFile(metadata);
  await chmod(f.path, 0o755); await assert.rejects(f.archive.read(saved.reference), { code: 'UNSAFE_ARCHIVE_PATH' }); await chmod(f.path, 0o700);
  const outside = join(f.root, 'outside'); await writeFile(outside, original, { mode: 0o600 });
  await rm(metadata); await symlink(outside, metadata); await assert.rejects(f.archive.read(saved.reference), { code: 'UNSAFE_ARCHIVE_PATH' });
  await rm(metadata); await link(outside, metadata); await assert.rejects(f.archive.read(saved.reference), { code: 'UNSAFE_ARCHIVE_PATH' });
  await rm(metadata); await writeFile(metadata, original, { mode: 0o600 });
  const nested = join(dir, 'data/bundle/nested'); await rm(nested, { recursive: true }); await symlink(f.source, nested);
  await assert.rejects(f.archive.materialize(saved.reference, join(f.root, 'out')), { code: 'UNSAFE_ARCHIVE_PATH' });
  await assert.rejects(stat(join(f.root, 'out')), { code: 'ENOENT' });
});

test('contract failures do not publish archives and archive sources cannot overlap the store', async t => {
  const f = await fixture(t); await writeFile(join(f.source, 'extra'), 'unclaimed');
  await assert.rejects(f.archive.capture(f.source, 'files'), { code: 'FILE_CONTRACT_VIOLATION' });
  assert.deepEqual(await readdir(f.path), []);
  await assert.rejects(f.archive.capture(f.path, 'files'), { code: 'OVERLAPPING_ARTIFACT_ROOTS' });
});
