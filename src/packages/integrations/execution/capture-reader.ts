import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { CapturedFile } from '@agentflow/engine';

/** Host-owned capture paths after termination; preserve exact bytes and bound reads against recorded evidence. */
export async function readCapturedBytes(file: CapturedFile, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 || !file.complete || file.truncated || file.error
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maxBytes) throw new Error('INVALID_RAW_CAPTURE');
  const before = await lstat(file.path);
  if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes) throw new Error('INVALID_RAW_CAPTURE');
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (value: typeof before) => value.isFile() && value.nlink === 1 && value.ino === before.ino && value.dev === before.dev
      && value.size === before.size && value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
    if (!same(await handle.stat())) throw new Error('RAW_CAPTURE_CHANGED');
    const bytes = new Uint8Array(before.size + 1); let size = 0;
    while (size < bytes.length) { const next = await handle.read(bytes, size, bytes.length - size, null); if (!next.bytesRead) break; size += next.bytesRead; }
    if (size !== before.size || !same(await handle.stat()) || !same(await lstat(file.path))) throw new Error('RAW_CAPTURE_CHANGED');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
