import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileScriptRecordReader } from './script-record-reader.js';

test('script raw reader enforces exact bytes, UTF-8, bounds and ordinary single-link files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-script-raw-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'stdout'), reader = new FileScriptRecordReader();
  const file = { path, bytes: 2, complete: true, truncated: false };
  await writeFile(path, '{}'); assert.equal(await reader.read(file, 65536), '{}');
  await assert.rejects(reader.read(file, 1)); await assert.rejects(reader.read({ ...file, bytes: 3 }, 65536));
  await writeFile(path, Buffer.from([0xff, 0x00])); await assert.rejects(reader.read(file, 65536));
  await rm(path); const other = join(root, 'other'); await writeFile(other, '{}');
  await symlink(other, path); await assert.rejects(reader.read(file, 65536)); await rm(path);
  await link(other, path); await assert.rejects(reader.read(file, 65536));
});
