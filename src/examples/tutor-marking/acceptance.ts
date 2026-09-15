import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceEvidence } from '../tutor-tools/acceptance-evidence.js';
import type { AgentExecutionDriver, ArtifactStore } from '@agentflow/engine';
import { createTutorReportApplication } from '../tutor-report/application.js';
import type { ReportContext, SubmissionCompleteness } from '../tutor-report/application.js';
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
  /** Caller records an actual user confirmation against the newly accepted immutable candidate. */
  readonly confirmSubmission?: (markedBundle: string) => Promise<SubmissionCompleteness | undefined>;
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
  const evidence = acceptanceEvidence(root, setup.driver), driver = evidence.driver;
  let cleanupComplete = true;
  let passed = false;
  const app = await createTutorMarkingApplication(join(root, 'marking'), { source: setup.source, tutorWorkspace: workspace, python,
    marker: setup.marker, reviewer: setup.reviewer, driver, ...limits });
  const marked = await app.run('real-scanned-marking');
  try {
    await writeFile(join(root, 'marking-workflow.json'), JSON.stringify(marked.snapshot, null, 2));
    await app.exportMarked(marked.snapshot.runId, join(root, 'marked'));
    await prepareMarkedReportSource(join(root, 'marked'), join(root, 'report-input'));
    const submissionCompleteness = await setup.confirmSubmission?.(join(root, 'marked'));
    if (submissionCompleteness !== undefined) await writeFile(join(root, 'submission-completeness.json'), JSON.stringify(submissionCompleteness, null, 2), { mode: 0o600 });
    const report = await createTutorReportApplication(join(root, 'reporting'), { source: join(root, 'report-input'), tutorWorkspace: workspace, python, context: setup.context,
      reporter: setup.reporter, driver, ...(submissionCompleteness === undefined ? {} : { submissionCompleteness }), ...limits });
    const reported = await report.run('real-scanned-report');
    try {
      await writeFile(join(root, 'report-workflow.json'), JSON.stringify(reported.snapshot, null, 2));
      const last = reported.snapshot.lastAccepted?.result;
      if (reported.snapshot.outcome === 'completed' && last?.status === 'accepted') { await report.files.materialize(last.output, reported.snapshot.runId, join(root, 'report')); passed = true; }
    } finally { try { await report.release(reported); } catch { cleanupComplete = false; } }
  } catch { /* Preserve failed outputs and exact workflow evidence without printing their contents. */ }
  finally { try { await app.release(marked); } catch { cleanupComplete = false; } }
  const evidenceComplete = evidence.complete, executions = evidence.executions;
  passed = passed && evidenceComplete && cleanupComplete;
  const summary = { root, passed, evidenceComplete, cleanupComplete, draftRun: setup.draftRun ?? null, syntheticMaterial: setup.syntheticMaterial, realModels: setup.realModels, executions };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}
