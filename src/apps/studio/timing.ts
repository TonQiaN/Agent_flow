import type { ExecutionIdentity } from '@agentflow/domain';
import type { RunEvent, RunRevision } from '@agentflow/integrations';

import type { RunTimeline, AttemptTiming } from './display-types.js';
export type { RunTimeline, AttemptTiming } from './display-types.js';
const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const key = (id: ExecutionIdentity) => `${id.runId}/${id.nodeTaskId}/${id.attemptId}/${id.attemptNumber}`;
/** Read-only projection of recorded boundaries; never infer a start from a finish. */
export function projectTimeline(rows: readonly RunRevision[], events: readonly RunEvent[], at?: number): RunTimeline {
  const result: RunTimeline = { startedAt: null, finishedAt: null, updatedAt: null, attempts: [], revisions: [] };
  const attempts = new Map<string, AttemptTiming>();
  for (const row of rows) {
    if (at !== undefined && (row.recordedAt === null || row.recordedAt > at)) continue;
    const raw = row.content as any, record = raw?.checkpoint ?? raw, snapshot = record?.snapshot;
    if (!snapshot?.runId) continue;
    result.revisions.push({ sequence: row.sequence, revision: row.revision, recordedAt: row.recordedAt, node: snapshot.currentNode, status: snapshot.status });
    if (result.revisions.length === 1) result.startedAt = row.recordedAt;
    result.updatedAt = row.recordedAt;
    const ensure = (node: string, identity: ExecutionIdentity, starting = false) => {
      const id = key(identity);
      let entry = attempts.get(id);
      if (!entry) {
        entry = { node, identity, startedAt: starting ? row.recordedAt : null, finishedAt: null, ended: false, execution: [] };
        attempts.set(id, entry);
      }
      return entry;
    };
    if (snapshot.currentIdentity) ensure(snapshot.currentNode, snapshot.currentIdentity, true);
    for (const a of record.attempts ?? []) {
      const ended = a.resultStep !== null || !!a.retry || !!a.interrupted;
      const entry = ensure(a.node, a.identity, !ended);
      if (ended && !entry.ended) { entry.finishedAt = row.recordedAt; entry.ended = true; }
    }
    for (const step of snapshot.steps ?? []) {
      const entry = ensure(step.node, step.result.identity);
      if (!entry.ended) { entry.finishedAt = row.recordedAt; entry.ended = true; }
    }
    if (['succeeded', 'failed', 'cancelled', 'exhausted'].includes(snapshot.status)) {
      result.finishedAt ??= row.recordedAt;
      for (const entry of attempts.values()) if (!entry.ended) { entry.finishedAt = row.recordedAt; entry.ended = true; }
    } else result.finishedAt = null;
  }
  for (const event of events) {
    if (at !== undefined && event.recordedAt > at) continue;
    const value = event.content as any;
    const entry = value.identity ? attempts.get(key(value.identity)) : undefined;
    const runner = value.kind === 'execution' ? value.runner : null;
    if (entry && validTime(runner?.startedAt) && validTime(runner?.finishedAt))
      entry.execution.push({ startedAt: runner.startedAt, finishedAt: runner.finishedAt });
  }
  result.attempts = [...attempts.values()];
  return result;
}
