import type { FileSource } from './display-types.js';
import { constants } from 'node:fs';
import { readFile, readdir, lstat, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import {
  FileContractRegistry,
  ContractRegistry,
  isArtifactPath,
} from '@agentflow/engine';
import {
  SqliteRunRecordStore,
  projectRun,
  FileArtifactArchive,
  redactView,
} from '@agentflow/integrations';
import type { RunView } from '@agentflow/integrations';
export const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
export const identifier = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export async function jsonFile(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function safeFile(root: string, path: string): Promise<Buffer> {
  if (!isArtifactPath(path)) throw new Error('文件路径无效');
  const base = await realpath(root);
  let cursor = base;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error('不读取符号链接');
  }
  if (relative(base, await realpath(cursor)).startsWith('..'))
    throw new Error('文件超出本次运行');
  const file = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024 ** 2)
      throw new Error('文件不可用');
    return await file.readFile();
  } finally {
    await file.close();
  }
}
export async function groups(dataRoot: string) {
  return (await readdir(join(dataRoot, 'runs'), { withFileTypes: true }))
    .filter((x) => x.isDirectory() && identifier(x.name))
    .map((x) => x.name);
}
export async function openRecords(root: string) {
  await lstat(join(root, 'records/runs.sqlite'));
  return SqliteRunRecordStore.open(join(root, 'records'));
}
export async function views(root: string) {
  const store = await openRecords(root);
  try {
    const result: { key: string; view: RunView }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await store.list({
        ...(after ? { after } : {}),
        limit: 100,
      });
      for (const row of page) {
        const view = projectRun(row);
        if (view) result.push({ key: row.runId, view });
      }
      if (page.length < 100) return result;
      after = page.at(-1)!.runId;
    }
  } finally {
    store.close();
  }
}
/** Select each Run independently at the same wall-clock point; never load recovery capabilities. */
export async function viewsAt(root: string, recordedAt: number, throughSequence?: number) {
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0)
    throw new Error('回放时间无效');
  const current = await views(root),
    store = await openRecords(root),
    result: typeof current = [];
  try {
    for (const entry of current) {
      const row = await store.revisionAt(entry.key, recordedAt, throughSequence);
      const selected = row ? projectRun(row) : null;
      if (selected) result.push({ key: entry.key, view: selected });
    }
    return result;
  } finally {
    store.close();
  }
}
export async function summaries(dataRoot: string) {
  return Promise.all(
    (await groups(dataRoot)).map(async (id) => {
      const root = join(dataRoot, 'runs', id);
      let meta: any;
      try {
        meta = await jsonFile(join(root, 'meta.json'));
        const all = await views(root).catch(() => []);
        const main =
          all.find((v) => v.view.runId === meta.mainRunId) ??
          all.find((v) => !v.view.runId.startsWith('parallel-')) ??
          all[0];
        const completion = await jsonFile(join(root, 'completion.json')).catch(
          () => null,
        );
        let status: string = main?.view.snapshot.status ?? 'queued';
        if (
          completion?.error &&
          !['succeeded', 'failed', 'cancelled', 'exhausted'].includes(status)
        )
          status = 'failed';
        if (
          !completion &&
          meta.pid &&
          !['succeeded', 'failed', 'cancelled', 'exhausted'].includes(status)
        ) {
          try {
            process.kill(meta.pid, 0);
          } catch {
            status = 'interrupted';
          }
        }
        return {
          ...meta,
          status,
          outcome: main?.view.snapshot.outcome ?? null,
          reason: completion?.error ?? main?.view.snapshot.reason ?? null,
          runCount: all.length,
          updatedAt: completion?.finishedAt ?? meta.createdAt,
        };
      } catch {
        return {
          id,
          title: id,
          status: 'unavailable',
          reason: '本地记录不可读',
          createdAt: meta?.createdAt ?? null,
        };
      }
    }),
  );
}
interface ListedFile {
  id: string;
  name: string;
  bytes: number;
  mediaType: string;
  sha256: string;
  accepted: boolean;
  runId: string;
  nodeTaskId?: string;
  archiveRoot: string | null;
  archiveId?: string;
  path: string;
  sequence?: number;
  unavailable?: string;
  sources: FileSource[];
}
export async function files(root: string, at?: number, throughSequence?: number): Promise<ListedFile[]> {
  const result: ListedFile[] = [],
    known = new Map<string, ListedFile[]>();
  const meta = await jsonFile(join(root, 'meta.json'));
  for (const file of at !== undefined && meta.createdAt > at ? [] : meta.uploads ?? [])
    result.push({
      ...file,
      id: hash('upload:' + file.path),
      accepted: true,
      runId: meta.mainRunId,
      archiveRoot: null,
      sources: [{ runId: meta.mainRunId, role: 'input', recordedAt: meta.createdAt }],
    });
  const candidates: {
    saved: any;
    accepted: boolean;
    runId: string;
    nodeTaskId?: string;
    sequence?: number;
    unavailable?: string;
    source: FileSource;
  }[] = [];
  const store = await openRecords(root).catch(() => null);
  if (!store) return result;
  try {
    for (const { view } of await (at === undefined
      ? views(root)
      : viewsAt(root, at, throughSequence))) {
      const identities = [...view.snapshot.steps.map(step => ({ node: step.node, identity: step.result.identity })), ...view.attempts as any[]];
      const source = (identity: any, role: FileSource['role'], node?: string, recordedAt?: number): FileSource => ({
        runId: view.runId, role, ...(node ? { node } : {}),
        ...(identity ? { node: identities.find(item => item.identity?.nodeTaskId === identity.nodeTaskId)?.node ?? node,
          nodeTaskId: identity.nodeTaskId, attemptId: identity.attemptId, attemptNumber: identity.attemptNumber } : {}),
        ...(recordedAt !== undefined ? { recordedAt } : {}),
      });
      for (const entry of view.values as any[])
        if (entry.saved?.schema === 'agentflow-workflow-files/v1')
          candidates.push({
            saved: entry.saved,
            accepted: true,
            runId: view.runId,
            nodeTaskId: entry.identity?.nodeTaskId,
            source: source(entry.identity ?? entry.saved.receipt?.identity, entry.identity ? 'output' : 'input', entry.node),
          });
      let after = 0;
      for (;;) {
        const page = await store.events(view.runId, after, 500);
        for (const row of page) {
          const event = row.content as any;
          if (
            event.kind === 'artifact' &&
            (at === undefined || (throughSequence === undefined ? row.recordedAt <= at : row.recordedAt < at))
          )
            candidates.push({
              saved: event.saved,
              accepted: event.accepted,
              runId: view.runId,
              nodeTaskId: event.identity?.nodeTaskId,
              sequence: row.sequence,
              source: source(event.identity, event.accepted ? 'output' : 'draft', undefined, row.recordedAt),
            });
        }
        if (page.length < 500) break;
        after = page.at(-1)!.sequence;
      }
    }
    for (const item of candidates) {
      const reference = item.saved.archive;
      if (!reference) continue;
      const existing = known.get(reference.id);
      if (existing) {
        for (const file of existing) {
          file.accepted ||= item.accepted;
          if (!file.sources.some(s => JSON.stringify(s) === JSON.stringify(item.source))) file.sources.push(item.source);
          // An output event gives a more precise owner than an input snapshot.
          if (item.nodeTaskId && !file.nodeTaskId) { file.nodeTaskId = item.nodeTaskId; file.runId = item.runId; }
        }
        continue;
      }
      let found = false;
      for (const folder of ['archive', 'tasks/archive', 'work/archive']) {
        try {
          const archiveRoot = join(root, folder),
            archive = new FileArtifactArchive(
              archiveRoot,
              new FileContractRegistry(new ContractRegistry()),
            );
          const manifest = await archive.read(reference);
          found = true;
          const listed: ListedFile[] = [];
          for (const file of manifest.files)
            listed.push({
              id: hash(reference.id + ':' + file.path),
              name: file.path,
              bytes: file.bytes,
              mediaType: file.mediaType,
              sha256: file.sha256,
              accepted: item.accepted,
              runId: item.runId,
              ...(item.nodeTaskId ? { nodeTaskId: item.nodeTaskId } : {}),
              archiveRoot,
              archiveId: reference.id,
              path: file.path,
              ...(item.sequence ? { sequence: item.sequence } : {}),
              sources: [item.source],
            });
          known.set(reference.id, listed);
          result.push(...listed);
          break;
        } catch {
          /* A different registered archive may own this reference. */
        }
      }
      if (!found) {
        const missing: ListedFile = {
          id: hash(reference.id),
          name: '文件归档不可用 · ' + reference.id,
          bytes: 0,
          mediaType: 'application/octet-stream',
          sha256: '',
          accepted: item.accepted,
          runId: item.runId,
          archiveRoot: null,
          path: '',
          ...(item.nodeTaskId ? { nodeTaskId: item.nodeTaskId } : {}),
          sources: [item.source],
          unavailable:
            '记录中的文件归档已丢失或校验失败，请检查本机数据目录或备份。',
        };
        known.set(reference.id, [missing]); result.push(missing);
      }
    }
    return result;
  } finally {
    store.close();
  }
}
export function publicFiles(list: ListedFile[]) {
  return list.map(
    ({ archiveRoot: _root, archiveId: _id, path: _path, ...file }) => file,
  );
}
export async function fileBytes(root: string, id: string) {
  const file = (await files(root)).find((f) => f.id === id);
  if (!file) throw new Error('文件未记录或已丢失');
  if (file.unavailable) throw new Error(file.unavailable);
  const bytes = await safeFile(
    file.archiveRoot
      ? join(file.archiveRoot, file.archiveId!, 'data')
      : join(root, 'uploads'),
    file.path,
  );
  if (hash(bytes) !== file.sha256) throw new Error('文件摘要不匹配，无法展示');
  return { file, bytes };
}
