/** Explicit report-only execution from a caller-supplied marked bundle; no remarking or receipt import. */
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createTutorReportApplication } from './application.js';
import { selectGradingHarness } from '../tutor-grading/selected-harness.js';
import { tutorMarkingPrompts } from '../tutor-marking/prompts.js';
import { acceptanceEvidence } from '../tutor-tools/acceptance-evidence.js';
import { sourceByteBudget } from '../tutor-tools/source-budget.js';
const path = (key: string) => { const value = process.env[key]; if (!value || !isAbsolute(value) || value.includes('\0')) throw new Error('REPORT_ACCEPTANCE_PATH_REQUIRED'); return value; };
const json = async (key: string) => { const bytes = await readFile(path(key)); if (bytes.length > 65536) throw new Error('REPORT_ACCEPTANCE_CONFIG_TOO_LARGE'); return JSON.parse(bytes.toString()); };
const integer = (key: string) => { const value = process.env[key]; if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error('REPORT_ACCEPTANCE_BUDGET_REQUIRED'); return Number(value); };
const maxSourceBytes = sourceByteBudget(integer('AGENTFLOW_SOURCE_MAX_BYTES'));
const selected = selectGradingHarness('codex', process.env, { timeoutMs: integer('AGENTFLOW_AGENT_TIMEOUT_MS'), maxInputBytes: maxSourceBytes + 128 * 1024 ** 2 });
const source = path('AGENTFLOW_REPORT_SOURCE'), context = await json('AGENTFLOW_REPORT_CONTEXT');
const tutorWorkspace = path('TUTOR_WORKSPACE'), python = path('TUTOR_PYTHON');
const submissionCompleteness = process.env.AGENTFLOW_REPORT_COMPLETENESS === undefined ? undefined : await json('AGENTFLOW_REPORT_COMPLETENESS');
const priorDraft = process.env.AGENTFLOW_REPORT_PRIOR_DRAFT === undefined ? undefined : path('AGENTFLOW_REPORT_PRIOR_DRAFT');
await mkdir(selected.acceptanceRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(selected.acceptanceRoot, 'report-codex-'));
const bundle = join(root, 'bundle'); await cp(source, bundle, { recursive: true, force: false, errorOnExist: true });
if (priorDraft !== undefined) await cp(priorDraft, join(bundle, 'source/prior-report-candidate.json'), { force: false, errorOnExist: true });
const evidence = acceptanceEvidence(root, store => selected.driver(store, root));
const prompt = tutorMarkingPrompts({ syntheticMaterial: false }).reporterPrompt + (priorDraft === undefined ? '' : ' source/prior-report-candidate.json is an unaccepted previous report draft. Reuse sound prose after checking current metrics and explicitly rebind its hash and IDs. Correct only supported defects, preserve that draft unchanged in source, and produce a fresh report-candidate.json. Normal completion and a fresh host report Gate are required.');
const app = await createTutorReportApplication(join(root, 'reporting'), { source: bundle, tutorWorkspace, python, context, maxSourceBytes, toolTimeoutMs: 300000,
  ...(submissionCompleteness === undefined ? {} : { submissionCompleteness }),
  reporter: { id: 'codex-reporter', prompt, config: selected.config }, driver: evidence.driver });
const run = await app.run('real-scanned-report'); let passed = false, cleanupComplete = true;
try {
  await writeFile(join(root, 'report-workflow.json'), JSON.stringify(run.snapshot, null, 2));
  const last = run.snapshot.lastAccepted?.result;
  if (run.snapshot.outcome === 'completed' && last?.status === 'accepted') {
    await app.files.materialize(last.output, run.snapshot.runId, join(root, 'report')); passed = true;
  }
} finally { try { await app.release(run); } catch { cleanupComplete = false; } }
const summary = { root, source, priorDraft: priorDraft ?? null, passed: passed && cleanupComplete && evidence.complete,
  evidenceComplete: evidence.complete, cleanupComplete, syntheticMaterial: false, realModels: true, executions: evidence.executions };
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary)); process.exitCode = summary.passed ? 0 : 1;
