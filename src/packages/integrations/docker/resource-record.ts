import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import { canonicalJson, snapshotJson } from '@agentflow/engine';

export interface DockerResourceRecord {
  readonly schema: 'agentflow-docker-resource/v1';
  readonly resourceId: string;
  readonly directory: string;
  readonly identity: ExecutionIdentity;
}
const equal = (a: unknown, b: unknown) => canonicalJson(snapshotJson(a)) === canonicalJson(snapshotJson(b));
export function resourceRecord(value: JsonValue, identity: ExecutionIdentity, workspaceRoot: string): DockerResourceRecord {
  const r = snapshotJson(value) as unknown as DockerResourceRecord;
  if (!r || Object.keys(r).sort().join(',') !== 'directory,identity,resourceId,schema' || r.schema !== 'agentflow-docker-resource/v1'
    || typeof r.resourceId !== 'string' || !/^af-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.resourceId)
    || typeof r.directory !== 'string' || dirname(r.directory) !== resolve(workspaceRoot) || !/^attempt-[A-Za-z0-9]{6}$/.test(basename(r.directory))
    || !isExecutionIdentity(r.identity) || Object.keys(r.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId'
    || !equal(r.identity, identity)) throw new Error('INVALID_DOCKER_RESOURCE_RECORD');
  return r;
}
async function directory(path: string, missing: boolean): Promise<boolean> {
  try {
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) throw new Error('UNSAFE_RESOURCE_DIRECTORY');
    return true;
  } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function writeResourceMarker(record: DockerResourceRecord): Promise<void> {
  await directory(dirname(record.directory), false); await directory(record.directory, false);
  const file = await open(join(record.directory, '.agentflow-resource.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
  const dir = await open(record.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
/** A missing task workspace does not prove a missing container. Existing workspaces need ownership. */
export async function verifyResourceDirectory(record: DockerResourceRecord): Promise<void> {
  if (!await directory(dirname(record.directory), true) || !await directory(record.directory, true)) return;
  const file = await open(join(record.directory, '.agentflow-resource.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 16384) throw new Error('UNSAFE_RESOURCE_MARKER');
    const bytes = Buffer.alloc(s.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== s.size || !equal(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), record)) throw new Error('RESOURCE_MARKER_MISMATCH');
  } finally { await file.close(); }
}
