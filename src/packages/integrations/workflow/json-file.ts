import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DefinitionError, snapshotJson } from '@agentflow/engine';
import type { FileManifest } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';

/** Only an already materialized private snapshot. No callback receives this file handle. */
export async function readSnapshotJson(root: string, manifest: FileManifest, path: string, maxBytes: number): Promise<JsonValue> {
  const entry = manifest.files.find(file => file.path === path);
  if (!entry || entry.bytes > maxBytes) throw new DefinitionError('INVALID_JSON_FILE_SOURCE');
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== entry.bytes) throw new DefinitionError('INVALID_JSON_FILE_SOURCE');
    const bytes = Buffer.alloc(entry.bytes + 1); let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    const after = await file.stat(), content = bytes.subarray(0, length);
    if (length !== entry.bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new DefinitionError('JSON_FILE_SOURCE_CHANGED');
    return snapshotJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
  } finally { await file.close(); }
}
