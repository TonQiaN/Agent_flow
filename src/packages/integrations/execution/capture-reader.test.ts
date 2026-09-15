import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCapturedBytes } from './capture-reader.js';
test('capture reader preserves bytes and rejects incomplete, inconsistent, linked and oversized evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-raw-record-'));
  try {
    const path = join(root, 'raw'), bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0, 0xff, 10]); await writeFile(path, bytes);
    const file = { path, bytes: bytes.length, complete: true, truncated: false };
    assert.deepEqual(await readCapturedBytes(file, 64), bytes);
    for (const patch of [{ bytes: 0 }, { bytes: 1.5 }, { complete: false }, { truncated: true }, { error: 'capture failure' }]) await assert.rejects(readCapturedBytes({ ...file, ...patch }, 64));
    for (const limit of [0, 1.5, 5, 16 * 1024 * 1024 + 1]) await assert.rejects(readCapturedBytes(file, limit));
    const alias = join(root, 'alias'); await symlink(path, alias); await assert.rejects(readCapturedBytes({ ...file, path: alias }, 64));
    await rm(alias); await link(path, alias); await assert.rejects(readCapturedBytes(file, 64));
  } finally { await rm(root, { recursive: true, force: true }); }
});
