import { phaseUnconfirmed } from './phases.js';
import type { JsonValue } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { canonicalJson, copyJson } from '../json.js';
import type { RunRecordStore } from '../persistence/types.js';
import { RunStoreError } from '../persistence/types.js';
import type { RestoredRunnerResource } from '../runner/types.js';
import { getPlan, snapshot } from './compiler.js';
import { loadWorkflowCheckpoint } from './load-checkpoint.js';
import { WorkflowRestoreError } from './restore-value.js';
import type { CompiledWorkflow } from './types.js';
import type { WorkflowRecoveryRecord, WorkflowRecoverySnapshot } from './recovery-record.js';
import { registerRecoveryHandoff } from './recovery-handoff.js';
export type { WorkflowRecoveryRecord, WorkflowRecoverySnapshot } from './recovery-record.js';

export interface WorkflowRecoveryHandle {
  /** Last committed facts, not a live lease or permission to execute an Attempt. */
  query(): WorkflowRecoverySnapshot;
  /** Common old-resource cleanup only. A conflict invalidates this handle's write authority. */
  cleanup(): Promise<WorkflowRecoverySnapshot>;
  /** Release this loader's independent file copies; durable recovery progress remains. */
  dispose(): Promise<void>;
}
const equal = (a: unknown, b: unknown): boolean => canonicalJson(copyJson(a)) === canonicalJson(copyJson(b));

/** Fresh installed composition and trusted store only. Never dispatches a node or imports model JSON. */
export async function claimWorkflowRecovery(compiled: CompiledWorkflow, runId: string, store: RunRecordStore): Promise<WorkflowRecoveryHandle> {
  // Reuse all history, installed-definition, contract and file-receipt checks before acquiring authority.
  const loaded = await loadWorkflowCheckpoint(compiled, runId, store), prior = loaded.recovery;
  try {
    const checkpoint = loaded.checkpoint, view = checkpoint.snapshot;
    if (!['queued', 'running', 'retry_wait', 'parallel_wait',...(checkpoint.attempts.at(-1)?.parallel?['cancelling']:[])].includes(view.status) || view.cancelRequested&&!checkpoint.attempts.at(-1)?.parallel) throw new DefinitionError('WORKFLOW_NOT_RECOVERABLE');
    const attempt = checkpoint.attempts.at(-1), active = attempt?.resultStep === null && !attempt.interrupted && !attempt.retry && !attempt.parallel ? attempt : null;
    const binding = active ? getPlan(compiled).bindings.get(active.node)! : null;
    if (active?.launch?.endsWith('_pending') || phaseUnconfirmed(active?.phases)) throw new DefinitionError('WORKFLOW_LAUNCH_UNCONFIRMED');
    const recomputable = binding && ['gate', 'transform'].includes(binding.component.kind)
      && !binding.executor.resourceDefinition && !binding.executor.restoreResource && !binding.executor.restorePhaseResource
      && binding.executor.checkRecovery && Object.values(binding.component.outcomes).every(id => binding.executor.contract(id).kind === 'json');
    if (binding && (binding.component.kind === 'effect' || recomputable)) {
      if (!binding.executor.checkRecovery || active!.resource !== null || active!.phases !== undefined) throw new DefinitionError('WORKFLOW_RESOURCE_RESTORE_UNAVAILABLE');
      await binding.executor.checkRecovery(snapshot(binding.component), snapshot(checkpoint.cursor.value), snapshot(active!.identity));
    } else if (binding && (active?.phases !== undefined ? !binding.executor.restorePhaseResource : !binding.executor.resourceDefinition || !binding.executor.restoreResource)) throw new DefinitionError('WORKFLOW_RESOURCE_RESTORE_UNAVAILABLE');
    const owned = active?.phases !== undefined ? active.phases.filter(p => p.resource !== null).map(p => ({ phase: p.id, record: p.resource! })).reverse()
      : active?.resource ? [{ phase: null, record: active.resource }] : [];
    if (!owned.length && prior && !prior.resourceRemoved) throw new DefinitionError('INVALID_WORKFLOW_RECOVERY_RECORD');
    let revision = loaded.revision;
    const claimRevision = revision + 1;
    if (!Number.isSafeInteger(claimRevision)) throw new DefinitionError('INVALID_WORKFLOW_RECOVERY_RECORD');
    let removed = prior?.resourceRemoved ?? !owned.length;
    let disposed = false, closing = false, lost = false, transferred = false;
    const resources = new Map<string, RestoredRunnerResource>();
    let pending: Promise<WorkflowRecoverySnapshot> | null = null, disposing: Promise<void> | null = null;
    const content = (resourceRemoved: boolean): WorkflowRecoveryRecord => ({ schema: 'agentflow-workflow-recovery/v1', checkpoint, claimRevision, resourceRemoved });
    const query = (): WorkflowRecoverySnapshot => snapshot({ ...content(removed), revision });
    const commit = async (resourceRemoved: boolean): Promise<void> => {
      if (disposed || lost) throw new DefinitionError('WORKFLOW_RECOVERY_HANDLE_CLOSED');
      const next = snapshot(content(resourceRemoved)) as unknown as JsonValue;
      try {
        const result = await store.compareAndSwap(runId, revision, next);
        if (result.runId !== runId || result.revision !== revision + 1 || !equal(result.content, next)) throw new DefinitionError('INVALID_WORKFLOW_RECOVERY_COMMIT');
        revision = result.revision; removed = resourceRemoved;
      } catch (error) { lost = true; throw error instanceof RunStoreError || error instanceof DefinitionError ? error : new DefinitionError('WORKFLOW_RECOVERY_PERSISTENCE_FAILED'); }
    };
    await commit(removed);
    const cleanup = (): Promise<WorkflowRecoverySnapshot> => {
      if (closing || disposed || lost) return Promise.reject(new DefinitionError('WORKFLOW_RECOVERY_HANDLE_CLOSED'));
      if (pending) return pending;
      pending = (async () => {
        // Revalidate current CAS authority before touching the immutable old resource identity.
        await commit(removed);
        if (!removed) {
          for (const item of owned) {
            let resource = resources.get(item.record.resource.id);
            if (!resource) {
              try { resource = item.phase === null ? await binding!.executor.restoreResource!(snapshot(binding!.component), snapshot(item.record))
                : await binding!.executor.restorePhaseResource!(snapshot(binding!.component), item.phase, snapshot(item.record)); resources.set(item.record.resource.id, resource); }
              catch (error) { throw new DefinitionError(error instanceof DefinitionError ? error.code : 'WORKFLOW_RESOURCE_RESTORE_FAILED'); }
            }
            if (!equal(resource.identity, active!.identity) || !equal(resource.resource, item.record.resource)) throw new DefinitionError('WORKFLOW_RECOVERED_RESOURCE_MISMATCH');
            try { await resource.query(); } catch { throw new DefinitionError('WORKFLOW_RECOVERY_QUERY_UNCONFIRMED'); }
            let confirmed: boolean;
            try { confirmed = (await resource.stopAndRemove()).confirmed; } catch { confirmed = false; }
            if (confirmed !== true) throw new DefinitionError('WORKFLOW_RECOVERY_STOP_UNCONFIRMED');
            try { await resource.release(); } catch { throw new DefinitionError('WORKFLOW_RECOVERY_RELEASE_FAILED'); }
          }
          await commit(true);
        }
        return query();
      })().finally(() => { pending = null; });
      return pending;
    };
    const dispose = (): Promise<void> => {
      if (transferred) return Promise.resolve();
      if (disposing) return disposing;
      closing = true;
      disposing = (async () => {
        if (pending) await pending.catch(() => {});
        disposed = true;
        await loaded.dispose();
      })().finally(() => { disposing = null; });
      return disposing;
    };
    const handle = Object.freeze({ query, cleanup, dispose });
    registerRecoveryHandoff(handle, () => {
      if (closing || disposed || lost || transferred || pending || !removed) throw new DefinitionError('WORKFLOW_RECOVERY_NOT_READY');
      transferred = true; closing = true;
      return { compiled, store, checkpoint: snapshot(checkpoint), revision, dispose: loaded.dispose };
    });
    return handle;
  } catch (error) {
    try { await loaded.dispose(); } catch { throw new WorkflowRestoreError('WORKFLOW_RECOVERY_DISPOSE_FAILED', loaded.dispose); }
    throw error;
  }
}
