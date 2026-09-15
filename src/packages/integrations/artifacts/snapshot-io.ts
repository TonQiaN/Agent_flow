import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, rmdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArtifactError, FileContractRegistry, isArtifactPath } from '@agentflow/engine';
import type { ArtifactMaterializer, FileManifest, FileEntry } from '@agentflow/engine';
const LIMITS = { entries: 10_000, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, jsonBytes: 1024 * 1024 };
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
const within = (parent: string, child: string): boolean => { const p = relative(parent, child); return p === '' || p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };

async function directory(path: string): Promise<void> {
  const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError('INVALID_DIRECTORY');
}

async function copyFile(source: string, target: string | undefined, path: string, maxBytes: number): Promise<{ bytes: number; sha256: string; prefix: Buffer; jsonBytes: Buffer | null }> {
  const before = await lstat(source);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new ArtifactError('INVALID_FILE', path);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const stat = await input.stat(); if (!stat.isFile() || !same(before, stat)) throw new ArtifactError('FILE_CHANGED', path);
    if (target !== undefined) output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0; let prefix = Buffer.alloc(0);
    const chunks: Buffer[] = []; const isJson = path.toLowerCase().endsWith('.json');
    if (isJson && stat.size > LIMITS.jsonBytes) throw new ArtifactError('JSON_TOO_LARGE', path);
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead); bytes += chunk.length;
      if (bytes > maxBytes) throw new ArtifactError('FILE_TOO_LARGE', path);
      if (!prefix.length) prefix = Buffer.from(chunk.subarray(0, 16));
      if (isJson) { if (bytes > LIMITS.jsonBytes) throw new ArtifactError('JSON_TOO_LARGE', path); chunks.push(Buffer.from(chunk)); }
      hash.update(chunk);
      for (let offset = 0; output && offset < chunk.length;) {
        const written = await output.write(chunk, offset, chunk.length - offset, null);
        if (!written.bytesWritten) throw new ArtifactError('COPY_FAILED', path); offset += written.bytesWritten;
      }
    }
    if (bytes !== stat.size || !same(stat, await input.stat()) || !same(stat, await lstat(source))) throw new ArtifactError('FILE_CHANGED', path);
    await (output ?? input).sync();
    return { bytes, sha256: hash.digest('hex'), prefix, jsonBytes: isJson ? Buffer.concat(chunks) : null };
  } finally { await input.close(); await output?.close(); }
}

function media(path: string, prefix: Buffer): string {
  if (path.toLowerCase().endsWith('.json')) return 'application/json';
  if (prefix.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (path.toLowerCase().endsWith('.txt')) return 'text/plain';
  if (path.toLowerCase().endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}


export interface StoredSnapshot { root: string; manifest: FileManifest; cleanupRoot?: string }

export async function captureSnapshot(root: string, contracts: FileContractRegistry, source: string | ArtifactMaterializer, contractId: string): Promise<StoredSnapshot> {
    const contract = contracts.definition(contractId);
    // Capture the installed capability before the first asynchronous operation.
    const materialize = typeof source === 'string' ? null : source.materialize.bind(source);
    let stage: string | undefined;
    try {
      let sourceRoot = '';
      if (typeof source === 'string') { await directory(source); sourceRoot = await realpath(source); }
      await mkdir(root, { recursive: true, mode: 0o700 }); await directory(root);
      const stat = await lstat(root);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new ArtifactError('INVALID_STORE_PERMISSIONS');
      const storeRoot = await realpath(root);
      if (!materialize && (within(sourceRoot, storeRoot) || within(storeRoot, sourceRoot))) throw new ArtifactError('OVERLAPPING_ARTIFACT_ROOTS');
      stage = await mkdtemp(join(storeRoot, 'snapshot-'));
      const dataRoot = materialize ? join(stage, 'data') : stage;
      if (materialize) {
        await materialize(dataRoot); await directory(dataRoot);
        sourceRoot = await realpath(dataRoot);
        if (sourceRoot !== dataRoot) throw new ArtifactError('INVALID_MATERIALIZED_ROOT');
      }
      const privateEntry = async (path: string, directory: boolean): Promise<void> => {
        if (!materialize) return;
        const stat = await lstat(path);
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new ArtifactError('INVALID_MATERIALIZED_PERMISSIONS');
      };
      await privateEntry(dataRoot, true);
      const entries: FileEntry[] = []; const files: FileManifest['files'][number][] = []; const directories: string[] = [];
      let totalBytes = 0;
      const walk = async (base: string): Promise<void> => {
        const current = join(sourceRoot, base); await directory(current);
        const iterator = await opendir(current);
        for await (const entry of iterator) {
          const path = base ? `${base}/${entry.name}` : entry.name;
          if (!isArtifactPath(path)) throw new ArtifactError('INVALID_ARTIFACT_PATH');
          if (entries.length >= LIMITS.entries) throw new ArtifactError('TOO_MANY_ENTRIES', path);
          const from = join(sourceRoot, path), to = join(dataRoot, path); const stat = await lstat(from);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            entries.push({ path, kind: 'directory' }); directories.push(path); await privateEntry(from, true); if (!materialize) await mkdir(to, { mode: 0o700 }); await walk(path);
          } else {
            if (files.length >= Math.min(contract.maxFiles, LIMITS.entries)) throw new ArtifactError('MAX_FILES', path);
            await privateEntry(from, false);
            const copied = await copyFile(from, materialize ? undefined : to, path, Math.min(LIMITS.fileBytes, contract.maxTotalBytes - totalBytes, LIMITS.totalBytes - totalBytes));
            totalBytes += copied.bytes;
            const mediaType = media(path, copied.prefix);
            let json;
            if (copied.jsonBytes !== null) {
              try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copied.jsonBytes)); }
              catch { throw new ArtifactError('INVALID_JSON', path); }
            }
            entries.push({ path, kind: 'file', bytes: copied.bytes, mediaType, ...(copied.jsonBytes === null ? {} : { json }) });
            files.push({ path, bytes: copied.bytes, sha256: copied.sha256, mediaType, rule: '' });
          }
        }
      };
      await walk('');
      const check = contracts.check(contractId, entries);
      if (!check.valid) throw new ArtifactError('FILE_CONTRACT_VIOLATION', '', check.issues);
      const owners = new Map(check.assignments.map(entry => [entry.path, entry.rule]));
      const keptDirectories = new Set(check.directories);
      // Only unclaimed empty directories are omitted. rmdir fails if unexpected content exists.
      for (const path of directories.filter(path => !keptDirectories.has(path)).sort((a, b) => b.length - a.length)) await rmdir(join(dataRoot, path));
      const manifest: FileManifest = { id: randomUUID(), contractId, directories: [...keptDirectories].sort(), files: files.map(file => ({ ...file, rule: owners.get(file.path)! })).sort((a, b) => a.path.localeCompare(b.path)) };
      const snapshot = { root: dataRoot, manifest, ...(materialize ? { cleanupRoot: stage } : {}) }; stage = undefined;
      return snapshot;
    } catch (error) {
      if (stage) await rm(stage, { recursive: true, force: true });
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError('CAPTURE_FAILED');
    }
  }

export async function materializeSnapshot(storeRoot: string, snapshot: StoredSnapshot, destination: string): Promise<void> {
    let created = false;
    try {
      if (!isAbsolute(destination) || resolve(destination) !== destination) throw new ArtifactError('INVALID_DESTINATION');
      const parent = await realpath(join(destination, '..'));
      if (within(await realpath(storeRoot), parent)) throw new ArtifactError('OVERLAPPING_ARTIFACT_ROOTS');
      await directory(snapshot.root); await mkdir(destination, { mode: 0o700 }); created = true;
      for (const path of snapshot.manifest.directories) {
        await directory(join(snapshot.root, path)); await mkdir(join(destination, path), { mode: 0o700 });
      }
      for (const file of snapshot.manifest.files) {
        const copied = await copyFile(join(snapshot.root, file.path), join(destination, file.path), file.path, file.bytes);
        if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new ArtifactError('ARTIFACT_INTEGRITY_MISMATCH', file.path);
      }
    } catch (error) {
      if (created) await rm(destination, { recursive: true, force: true });
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError('MATERIALIZE_FAILED');
    }
  }
