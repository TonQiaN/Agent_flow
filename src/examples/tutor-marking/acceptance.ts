import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutionDriver, ArtifactStore, Cancellation, FileManifest, HarnessTask, InvocationPhaseSink } from '@agentflow/engine';
import { createTutorReportApplication } from '../tutor-report/application.js';
import type { ReportContext } from '../tutor-report/application.js';
import { createTutorMarkingApplication, prepareMarkedReportSource } from './application.js';
import type { MarkingAgent } from './application.js';

export interface MarkingAcceptanceSetup {
  readonly root: string;
  readonly source: string;
  readonly tutorWorkspace: string;
  readonly python: string;
  readonly syntheticMaterial: boolean;
  readonly realModels: boolean;
  readonly draftRun?: string;
  readonly context: ReportContext;
  readonly marker: MarkingAgent;
  readonly reviewer: MarkingAgent;
  readonly reporter: MarkingAgent;
  readonly driver: (store: ArtifactStore) => AgentExecutionDriver;
  readonly maxSourceBytes?: number;
  readonly toolTimeoutMs?: number;
}
/** The same ordinary Workflow, Gate and evidence path for synthetic and explicitly supplied sources. */
export async function runMarkingAcceptance(setup: MarkingAcceptanceSetup) {
  const { root, python, tutorWorkspace: workspace } = setup;
  const limits = { ...(setup.maxSourceBytes === undefined ? {} : { maxSourceBytes: setup.maxSourceBytes }),
    ...(setup.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: setup.toolTimeoutMs }) };
  const executions: object[] = [];
  let evidenceComplete = true;
  let cleanupComplete = true;
  class RecordingDriver implements AgentExecutionDriver {
    readonly inner: AgentExecutionDriver;
    get harness() { return this.inner.harness; }
    constructor(store: ArtifactStore) { this.inner = setup.driver(store); }
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
  const driver = (store: ArtifactStore) => new RecordingDriver(store);
  let passed = false;
  const app = await createTutorMarkingApplication(join(root, 'marking'), { source: setup.source, tutorWorkspace: workspace, python,
    marker: setup.marker, reviewer: setup.reviewer, driver, ...limits });
  const marked = await app.run('real-scanned-marking');
  try {
    await writeFile(join(root, 'marking-workflow.json'), JSON.stringify(marked.snapshot, null, 2));
    await app.exportMarked(marked.snapshot.runId, join(root, 'marked'));
    await prepareMarkedReportSource(join(root, 'marked'), join(root, 'report-input'));
    const report = await createTutorReportApplication(join(root, 'reporting'), { source: join(root, 'report-input'), tutorWorkspace: workspace, python, context: setup.context,
      reporter: setup.reporter, driver, ...limits });
    const reported = await report.run('real-scanned-report');
    try {
      await writeFile(join(root, 'report-workflow.json'), JSON.stringify(reported.snapshot, null, 2));
      const last = reported.snapshot.lastAccepted?.result;
      if (reported.snapshot.outcome === 'completed' && last?.status === 'accepted') { await report.files.materialize(last.output, reported.snapshot.runId, join(root, 'report')); passed = true; }
    } finally { try { await report.release(reported); } catch { cleanupComplete = false; } }
  } catch { /* Preserve failed outputs and exact workflow evidence without printing their contents. */ }
  finally { try { await app.release(marked); } catch { cleanupComplete = false; } }
  passed = passed && evidenceComplete && cleanupComplete;
  const summary = { root, passed, evidenceComplete, cleanupComplete, draftRun: setup.draftRun ?? null, syntheticMaterial: setup.syntheticMaterial, realModels: setup.realModels, executions };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}
