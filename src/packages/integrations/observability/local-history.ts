import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CompiledWorkflow, FileContractRegistry, WorkflowObserver } from '@agentflow/engine';
import { FileArtifactArchive } from '../artifacts/file-archive.js';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
import { createWorkflowRecorder } from './views.js';
/** Shared durable viewing path for original CLI compositions. Tests may opt out explicitly. */
export async function localWorkflowHistory(entrypoint: string, contracts?: FileContractRegistry) {
  if (process.env['AGENTFLOW_HISTORY_DISABLED'] === '1' && !process.env['AGENTFLOW_STUDIO_RUN_ROOT']) return { archive: undefined, observer: (_compiled: CompiledWorkflow): WorkflowObserver => async () => {} };
  const root = process.env['AGENTFLOW_STUDIO_RUN_ROOT'] ?? join(resolve(process.env['AGENTFLOW_STUDIO_DATA'] ?? '.local/studio'), 'runs', `cli-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const archive = contracts ? new FileArtifactArchive(join(root, 'archive'), contracts) : undefined;
  return { root, archive, observer: (compiled: CompiledWorkflow): WorkflowObserver => {
    let record: Awaited<ReturnType<typeof createWorkflowRecorder>> | undefined, store: SqliteRunRecordStore | undefined;
    return async observation => {
      if (!record) {
        store = await SqliteRunRecordStore.open(join(root, 'records'));
        record = await createWorkflowRecorder(store, compiled, { title: entrypoint, entrypoint });
        if (!process.env['AGENTFLOW_STUDIO_RUN_ROOT']) await writeFile(join(root, 'meta.json'), JSON.stringify({ id: root.split('/').at(-1), workflowId: compiled.definition.id, title: entrypoint, createdAt: Date.now(), mainRunId: observation.snapshot.runId, source: 'cli' }), { mode: 0o600 });
      }
      try { await record(observation); } finally { if (['succeeded', 'failed', 'cancelled', 'exhausted'].includes(observation.snapshot.status)) store!.close(); }
    };
  } };
}
