import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutionDriver, ArtifactStore, Cancellation, FileManifest, HarnessTask, InvocationPhaseSink } from '@agentflow/engine';

/** Private acceptance evidence; never substitutes for normal engine receipt validation. */
export function acceptanceEvidence(root: string, factory: (store: ArtifactStore) => AgentExecutionDriver) {
  const executions: object[] = [];
  let evidenceComplete = true;
  class RecordingDriver implements AgentExecutionDriver {
    readonly inner: AgentExecutionDriver;
    get harness() { return this.inner.harness; }
    constructor(store: ArtifactStore) { this.inner = factory(store); }
    validate(task: HarnessTask) { this.inner.validate(task); }
    async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation, phases?: InvocationPhaseSink) {
      const handle = await this.inner.run(task, input, cancellation, phases);
      const record = { identity: task.identity, status: handle.facts.harness?.status, version: handle.facts.version,
        runner: handle.facts.runner.phase, exitCode: handle.facts.runner.exitCode, images: (task.config as { inputImages?: string[] }).inputImages ?? [], released: false, evidenceComplete: false };
      executions.push(record);
      try {
        const dir = join(root, 'evidence', `${task.identity.runId}-${task.identity.nodeTaskId}`); await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, 'execution.json'), JSON.stringify(handle.facts, null, 2), { mode: 0o600 });
        if (handle.facts.runner.capture) {
          for (const stream of ['stdout', 'stderr'] as const) if (handle.facts.runner.capture[stream].complete) await cp(handle.facts.runner.capture[stream].path, join(dir, `${stream}.bin`));
          await cp(handle.facts.runner.capture.outputsPath, join(dir, 'outputs'), { recursive: true });
        }
        record.evidenceComplete = true;
      } catch { evidenceComplete = false; /* Keep the real handle so the engine can own cleanup/recovery. */ }
      return { get facts() { return handle.facts; }, retryCleanup: () => handle.retryCleanup(), release: async () => { await handle.release(); record.released = true; } };
    }
  }
  return { driver: (store: ArtifactStore) => new RecordingDriver(store), executions, get complete() { return evidenceComplete; } };
}
