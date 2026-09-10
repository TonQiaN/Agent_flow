import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyInput, captureFile, safeRelative } from './files.js';
import { DockerBackend } from './backend.js';

test('input copies preserve nested paths, permit edits and never hardlink the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-copy-'));
  try {
    const source = join(root, 'source'); const target = join(root, 'target');
    await mkdir(join(source, 'nested'), { recursive: true }); await mkdir(target);
    const original = join(source, 'nested', 'answer.txt'); const copied = join(target, 'nested', 'answer.txt');
    await writeFile(original, 'original'); await chmod(original, 0o400);
    await copyInput(source, target);
    assert.notEqual((await stat(original)).ino, (await stat(copied)).ino);
    await writeFile(copied, 'modified');
    assert.equal(await readFile(original, 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('input links and copy resource limits reject rather than silently omitting content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-links-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'file'), '12345'); await symlink('file', join(source, 'link'));
    await mkdir(join(root, 'target'));
    await assert.rejects(copyInput(source, join(root, 'target')), /INPUT_LINK_REJECTED/);
    await rm(join(source, 'link')); await mkdir(join(root, 'small'));
    await assert.rejects(copyInput(source, join(root, 'small'), { maxFiles: 1, maxBytes: 2 }), /INPUT_SIZE_LIMIT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('raw file capture is byte preserving, bounded and refuses missing files or links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-capture-'));
  try {
    await writeFile(join(root, 'events'), Buffer.from([0xff, 0x00, 0x01, 0x02]));
    const result = await captureFile(root, 'events', join(root, 'captured'), 2);
    assert.equal(result.truncated, true); assert.equal(result.complete, false); assert.equal(result.bytes, 2);
    assert.deepEqual(await readFile(result.path), Buffer.from([0xff, 0x00]));
    await symlink('events', join(root, 'link'));
    execFileSync('mkfifo', [join(root, 'pipe')]);
    for (const path of ['link', 'pipe', 'missing', '../events']) assert.equal((await captureFile(root, path, join(root, 'rejected'), 10)).error, 'RECORD_CAPTURE_FAILED');
    for (const path of ['../a', '/a', 'a/../b', 'a//b', 'a\\b', '']) assert.equal(safeRelative(path), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Docker configuration explicitly rejects unsupported network, root and unbounded options', () => {
  const options = { workspaceRoot: '/tmp/af-test', image: 'alpine:3' };
  assert.doesNotThrow(() => new DockerBackend(options));
  assert.throws(() => new DockerBackend({ ...options, network: 'bridge' as 'none' }), /INVALID_DOCKER_OPTIONS/);
  assert.throws(() => new DockerBackend({ ...options, sandbox: 'unconfined' as 'standard' }), /INVALID_DOCKER_OPTIONS/);
  assert.throws(() => new DockerBackend({ ...options, uid: 0 }), /INVALID_DOCKER_OPTIONS/);
  assert.throws(() => new DockerBackend({ ...options, logBytes: Infinity }), /INVALID_DOCKER_OPTIONS/);
});
