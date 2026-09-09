import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { SCRIPT_RESULT_MAX_BYTES } from '@agentflow/engine';
import type { CapturedFile, ScriptRecordReader } from '@agentflow/engine';

/** Capture path and its ancestors are supplied by a trusted backend after termination. */
export class FileScriptRecordReader implements ScriptRecordReader {
  async read(file: CapturedFile, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SCRIPT_RESULT_MAX_BYTES) throw new Error('INVALID_SCRIPT_CAPTURE_LIMIT');
    const before = await lstat(file.path);
    if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes || before.size > maxBytes) throw new Error('INVALID_SCRIPT_CAPTURE');
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) throw new Error('INVALID_SCRIPT_CAPTURE');
      const bytes = new Uint8Array(before.size + 1); let size = 0;
      while (size < bytes.length) { const next = await handle.read(bytes, size, bytes.length - size, null); if (!next.bytesRead) break; size += next.bytesRead; }
      const after = await handle.stat(), pathAfter = await lstat(file.path);
      if (size !== before.size || [after, pathAfter].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size
        || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.nlink !== 1 || !s.isFile())) throw new Error('SCRIPT_CAPTURE_CHANGED');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    } finally { await handle.close(); }
  }
}
