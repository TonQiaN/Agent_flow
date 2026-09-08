import { constants } from 'node:fs';
import { lstat, readdir, mkdir, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { CapturedFile } from '@agentflow/engine';

const outside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part);
};

/** Sources are trusted, quiescent host snapshots; reject links rather than following them. */
export async function copyInput(source: string, destination: string, limits = { maxFiles: 4096, maxBytes: 256 * 1024 * 1024 }): Promise<void> {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_INPUT_DIRECTORY');
  const root = await realpath(source);
  let files = 0;
  let bytes = 0;
  let entries = 0;
  async function walk(from: string, to: string, depth: number): Promise<void> {
    if (depth > 64 || outside(root, await realpath(from))) throw new Error('INPUT_TREE_LIMIT');
    for (const name of await readdir(from)) {
      if (++entries > limits.maxFiles * 2) throw new Error('INPUT_TREE_LIMIT');
      const path = join(from, name);
      const target = join(to, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('INPUT_LINK_REJECTED');
      if (stat.isDirectory()) { await mkdir(target, { mode: 0o700 }); await walk(path, target, depth + 1); }
      else if (stat.isFile()) {
        if (++files > limits.maxFiles || outside(root, await realpath(path))) throw new Error('INPUT_TREE_LIMIT');
        const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await input.stat();
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error('INPUT_CHANGED');
          const output = await open(target, 'wx', 0o600);
          try {
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              const read = await input.read(buffer, 0, buffer.length, null);
              if (!read.bytesRead) break;
              bytes += read.bytesRead;
              if (bytes > limits.maxBytes) throw new Error('INPUT_SIZE_LIMIT');
              let offset = 0;
              while (offset < read.bytesRead) offset += (await output.write(buffer, offset, read.bytesRead - offset)).bytesWritten;
            }
          } finally { await output.close(); }
          const after = await input.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('INPUT_CHANGED');
        } finally { await input.close(); }
      } else throw new Error('INPUT_NON_REGULAR_FILE');
    }
  }
  await walk(root, destination, 0);
}

export function safeRelative(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.includes('\\') && !path.includes('\0')
    && !isAbsolute(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export async function captureFile(root: string, path: string, destination: string, maxBytes: number): Promise<CapturedFile> {
  let bytes = 0;
  try {
    if (!safeRelative(path)) throw new Error('UNSAFE_RECORD_PATH');
    let cursor = root;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('RECORD_LINK');
    }
    if (outside(await realpath(root), await realpath(cursor))) throw new Error('RECORD_ESCAPE');
    if (!(await lstat(cursor)).isFile()) throw new Error('RECORD_NON_REGULAR');
    const input = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await input.stat();
      if (!stat.isFile()) throw new Error('RECORD_NON_REGULAR');
      const output = await open(destination, 'wx', 0o600);
      try {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
        while (bytes < maxBytes) {
          const read = await input.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes), null);
          if (!read.bytesRead) break;
          let offset = 0;
          while (offset < read.bytesRead) offset += (await output.write(buffer, offset, read.bytesRead - offset)).bytesWritten;
          bytes += read.bytesRead;
        }
        const truncated = stat.size > bytes;
        return { path: destination, bytes, truncated, complete: !truncated };
      } finally { await output.close(); }
    } finally { await input.close(); }
  } catch { return { path: destination, bytes, truncated: false, complete: false, error: 'RECORD_CAPTURE_FAILED' }; }
}
