import { constants } from 'node:fs';
import { lstat, readdir, open, unlink } from 'node:fs/promises';
const root = '/task/state/deepseek/sessions';
const destination = '/task/state/deepseek-session.jsonl';
const maximum = 16 * 1024 * 1024;

/** Trusted post-exit operation. Never call while the native CLI or a tool can still write. */
export async function captureDeepseekSession() {
  let created = false;
  try {
    for (const path of ['/task', '/task/state', '/task/state/deepseek', root]) {
      const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    // The pinned persistence layout is root/project/session/session.jsonl. A fresh attempt owns one log.
    let count = 0; const candidates = [];
    async function walk(path, depth) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (++count > 128 || entry.isSymbolicLink()) throw new Error();
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory() && depth < 2) await walk(child, depth + 1);
        else if (entry.isFile() && depth === 2 && entry.name === 'session.jsonl') candidates.push(child);
        else throw new Error();
      }
    }
    await walk(root, 0);
    if (candidates.length !== 1) throw new Error();
    const source = await open(candidates[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error();
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) {
        const part = await source.read(bytes, length, bytes.length - length, null);
        if (!part.bytesRead) break; length += part.bytesRead;
      }
      const after = await source.stat();
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error();
      const output = await open(destination, 'wx', 0o600); created = true;
      try { await output.writeFile(bytes.subarray(0, length)); await output.sync(); }
      finally { await output.close(); }
      return { bytes: length };
    } finally { await source.close(); }
  } catch {
    if (created) await unlink(destination).catch(() => {});
    throw new Error('DEEPSEEK_SESSION_CAPTURE_FAILED');
  }
}
