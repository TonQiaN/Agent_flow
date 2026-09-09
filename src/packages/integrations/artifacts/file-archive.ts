import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isIdentifier } from '@agentflow/domain';
import { ArtifactError, FileContractRegistry, isArtifactPath, snapshotJson } from '@agentflow/engine';
import type { ArtifactArchive, ArtifactArchiveReference, ArchivedArtifact, FileManifest } from '@agentflow/engine';
import { captureSnapshot, materializeSnapshot } from './snapshot-io.js';

const limit = 16 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]): boolean => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const invalid = (): never => { throw new ArtifactError('INVALID_ARCHIVE_MANIFEST'); };
const mapped = (error: unknown): ArtifactError => error instanceof ArtifactError ? error : new ArtifactError('ARCHIVE_IO_ERROR');
function reference(value: ArtifactArchiveReference): ArtifactArchiveReference {
  let copy: unknown; try { copy = snapshotJson(value); } catch { throw new ArtifactError('INVALID_ARCHIVE_REFERENCE'); }
  if (!object(copy) || !keys(copy, ['id', 'sha256']) || typeof copy.id !== 'string' || !uuid.test(copy.id)
    || typeof copy.sha256 !== 'string' || !digest.test(copy.sha256)) throw new ArtifactError('INVALID_ARCHIVE_REFERENCE');
  return { id: copy.id, sha256: copy.sha256 };
}
function manifest(value: unknown, id: string): FileManifest {
  if (!object(value) || !keys(value, ['version', 'manifest']) || value.version !== 1 || !object(value.manifest)) return invalid();
  const m = value.manifest;
  if (!keys(m, ['id', 'contractId', 'directories', 'files']) || m.id !== id || !isIdentifier(m.contractId)
    || !Array.isArray(m.directories) || !Array.isArray(m.files) || m.directories.length + m.files.length > 10_000) return invalid();
  const dirs = new Set<string>(), paths = new Set<string>(); let total = 0;
  for (const path of m.directories) {
    if (!isArtifactPath(path) || paths.has(path)) return invalid(); dirs.add(path); paths.add(path);
  }
  for (const file of m.files) {
    if (!object(file) || !keys(file, ['path', 'bytes', 'sha256', 'mediaType', 'rule']) || !isArtifactPath(file.path)
      || paths.has(file.path) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 64 * 1024 * 1024
      || typeof file.sha256 !== 'string' || !digest.test(file.sha256) || typeof file.mediaType !== 'string' || !file.mediaType || !isIdentifier(file.rule)) return invalid();
    paths.add(file.path); total += file.bytes;
  }
  if (total > 256 * 1024 * 1024) return invalid();
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (!dirs.has(parts.join('/'))) return invalid(); parts.pop(); }
  }
  // Canonical parent-first directories; files use the same ordering as the common capture.
  if (JSON.stringify(m.directories) !== JSON.stringify([...dirs].sort())
    || JSON.stringify(m.files.map(f => f.path)) !== JSON.stringify(m.files.map(f => f.path).sort((a, b) => a.localeCompare(b)))) return invalid();
  return m as unknown as FileManifest;
}
async function privatePath(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) || stat.uid !== process.getuid!()
    || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new ArtifactError('UNSAFE_ARCHIVE_PATH');
}
async function syncDirectory(path: string): Promise<void> {
  await privatePath(path, true);
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Durable host-owned files. Never use as the temporary ArtifactStore of an execution handle. */
export class FileArtifactArchive implements ArtifactArchive {
  constructor(readonly root: string, readonly contracts: FileContractRegistry) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes('\0') || !process.getuid) throw new ArtifactError('INVALID_ARCHIVE_ROOT');
  }
  async #root(create = false): Promise<void> {
    if (create) {
      await mkdir(this.root, { mode: 0o700 });
      const parent = await open(dirname(this.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    await privatePath(this.root, true);
  }
  async capture(source: string, contractId: string): Promise<ArchivedArtifact> {
    let snapshotRoot: string | undefined, stage: string | undefined;
    try {
      // Explicit leaf root: its parent must already exist and be owned by the host.
      try { await this.#root(true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await this.#root(); }
      const snapshot = await captureSnapshot(this.root, this.contracts, source, contractId); snapshotRoot = snapshot.root;
      const text = JSON.stringify({ version: 1, manifest: snapshot.manifest });
      if (Buffer.byteLength(text) > limit) throw new ArtifactError('ARCHIVE_MANIFEST_TOO_LARGE');
      manifest(JSON.parse(text), snapshot.manifest.id);
      stage = await mkdtemp(join(this.root, '.publish-'));
      await rename(snapshot.root, join(stage, 'data')); snapshotRoot = undefined;
      for (const path of [...snapshot.manifest.directories].reverse()) await syncDirectory(join(stage, 'data', path));
      await syncDirectory(join(stage, 'data'));
      const metadata = await open(join(stage, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await metadata.writeFile(text); await metadata.sync(); } finally { await metadata.close(); }
      await syncDirectory(stage);
      await rename(stage, join(this.root, snapshot.manifest.id)); stage = undefined;
      await syncDirectory(this.root);
      return { reference: { id: snapshot.manifest.id, sha256: hash(text) }, manifest: structuredClone(snapshot.manifest) };
    } catch (error) { throw mapped(error); }
    finally {
      if (snapshotRoot) await rm(snapshotRoot, { recursive: true, force: true });
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  }
  async read(value: ArtifactArchiveReference): Promise<FileManifest> {
    const ref = reference(value);
    try {
      await this.#root(); const directory = join(this.root, ref.id); await privatePath(directory, true);
      const path = join(directory, 'manifest.json'); await privatePath(path, false);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.size > limit) throw new ArtifactError('UNSAFE_ARCHIVE_MANIFEST');
        // Bounded read even if a host-side writer unexpectedly grows the file.
        const bytes = Buffer.alloc(stat.size + 1); let count = 0;
        while (count < bytes.length) { const n = await handle.read(bytes, count, bytes.length - count, null); if (!n.bytesRead) break; count += n.bytesRead; }
        const after = await handle.stat();
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
          || hash(bytes.subarray(0, count)) !== ref.sha256) throw new ArtifactError('ARCHIVE_INTEGRITY_MISMATCH');
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))); } catch { return invalid(); }
        return manifest(parsed, ref.id);
      } finally { await handle.close(); }
    } catch (error) { throw mapped(error); }
  }
  async materialize(value: ArtifactArchiveReference, destination: string): Promise<void> {
    const ref = reference(value);
    try {
      const saved = await this.read(ref), data = join(this.root, ref.id, 'data'); await privatePath(data, true);
      for (const path of saved.directories) await privatePath(join(data, path), true);
      for (const file of saved.files) await privatePath(join(data, file.path), false);
      await materializeSnapshot(this.root, { root: data, manifest: saved }, destination);
    } catch (error) { throw mapped(error); }
  }
}
