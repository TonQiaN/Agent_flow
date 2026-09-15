/** Explicit caller-supplied student bundle. No student discovery, DB access, or fixture fallbacks. */
import { cp, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SubmissionCompleteness } from '../tutor-report/application.js';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectGradingHarness } from '../tutor-grading/selected-harness.js';
import { runMarkingAcceptance } from './acceptance.js';
import { tutorMarkingPrompts } from './prompts.js';
import { sourceByteBudget } from '../tutor-tools/source-budget.js';
const required = (key: string): string => { const value = process.env[key]; if (!value || value.includes('\0')) throw new Error('STUDENT_ACCEPTANCE_CONFIGURATION_REQUIRED'); return value; };
const path = (key: string): string => { const value = required(key); if (!isAbsolute(value)) throw new Error('STUDENT_ACCEPTANCE_ABSOLUTE_PATH_REQUIRED'); return value; };
const integer = (key: string) => { const value = required(key); if (!/^[1-9][0-9]*$/.test(value)) throw new Error('STUDENT_ACCEPTANCE_BUDGET_REQUIRED'); return Number(value); };
const source = path('AGENTFLOW_MARKING_SOURCE'), workspace = path('TUTOR_WORKSPACE'), python = path('TUTOR_PYTHON');
const timeoutMs = integer('AGENTFLOW_AGENT_TIMEOUT_MS'), maxSourceBytes = sourceByteBudget(integer('AGENTFLOW_SOURCE_MAX_BYTES'));
const selected = selectGradingHarness('codex', process.env, { timeoutMs, maxInputBytes: maxSourceBytes + 128 * 1024 ** 2 });
const contextBytes = await readFile(path('AGENTFLOW_REPORT_CONTEXT'));
if (contextBytes.byteLength > 65536) throw new Error('STUDENT_REPORT_CONTEXT_TOO_LARGE');
const context = JSON.parse(contextBytes.toString('utf8'));
const inputImages = (await readdir(join(source, 'source/prompt-images'))).sort().map(name => `source/prompt-images/${name}`);
if (!inputImages.length) throw new Error('STUDENT_IMAGES_REQUIRED');
const referenceImages = await readdir(join(source, 'source/reference-images')).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return []; throw error;
});
const referencePaths = referenceImages.sort().map(name => `source/reference-images/${name}`);
const imageRoles = ` Initial attachment order: the first ${inputImages.length} images are student submissions; the remaining ${referencePaths.length} are authoritative source PDF pages, in this exact order: ${referencePaths.join(', ')}. Source images are not student responses. Use the original PDF visuals to resolve radicals, signs, fractions and diagrams; plain-text extraction may lose mathematical symbols. Review source/review-notes.md if provided as author observations, verify every observation against the actual images, and correct only evidence-supported defects. Reference body/context must contain the actual assessable question and necessary stem, never placeholder labels such as Question 11. Preserve identical parent context across all parts of one question and retain subgroup-specific stems in the corresponding part bodies.`;
const confirmationPath = process.env.AGENTFLOW_SUBMISSION_CONFIRMATION;
let userConfirmation: { confirmedAt: string; text: string } | undefined;
if (confirmationPath !== undefined) {
  if (!isAbsolute(confirmationPath)) throw new Error('STUDENT_CONFIRMATION_ABSOLUTE_PATH_REQUIRED');
  const bytes = await readFile(confirmationPath);
  if (bytes.byteLength > 16384) throw new Error('STUDENT_CONFIRMATION_TOO_LARGE');
  const value = JSON.parse(bytes.toString('utf8'));
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000 || typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))) throw new Error('STUDENT_CONFIRMATION_INVALID');
  userConfirmation = { text: value.text, confirmedAt: value.confirmedAt };
}
const confirmSubmission = async (markedBundle: string): Promise<SubmissionCompleteness | undefined> => {
  if (!userConfirmation) return undefined;
  const bytes = await readFile(join(markedBundle, 'candidate/marking-candidate.json'));
  const candidate = JSON.parse(bytes.toString('utf8'));
  const missing = candidate.item_results.filter((item: { response_status: string }) => item.response_status === 'MISSING');
  if (!missing.length) return undefined;
  return { schema_version: 1, job_id: context.reportId, candidate_sha256: createHash('sha256').update(bytes).digest('hex'),
    confirmed_at: userConfirmation.confirmedAt, confirmation_text: userConfirmation.text, submission_complete: true,
    missing_item_ids: missing.map((item: { assessable_item: { id: string } }) => item.assessable_item.id) };
};
const priorDraft = process.env.AGENTFLOW_MARKING_PRIOR_DRAFT;
if (priorDraft !== undefined && !isAbsolute(priorDraft)) throw new Error('STUDENT_DRAFT_ABSOLUTE_PATH_REQUIRED');
const config = { ...selected.config, inputImages: [...inputImages, ...referencePaths] }, prompts = tutorMarkingPrompts({ syntheticMaterial: false });
await mkdir(selected.acceptanceRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(selected.acceptanceRoot, 'student-codex-'));
const taskSource = join(root, 'bundle'); await cp(source, taskSource, { recursive: true, force: false, errorOnExist: true });
const checks = join(taskSource, 'source/self-check'); await mkdir(checks, { recursive: false });
for (const [from, name] of [
  [join(workspace, 'agentflows/exam-evaluation/runtime/contracts.py'), 'contracts.py'],
  [join(workspace, 'agentflows/exam-evaluation/runtime/agentflow_protocol.py'), 'agentflow_protocol.py'],
  [join(workspace, 'agentflows/exam-evaluation/marking/trusted/validation.py'), 'validation.py'],
  [fileURLToPath(new URL('./self-check.py', import.meta.url)), 'check.py'],
] as const) await cp(from, join(checks, name), { force: false, errorOnExist: true });
if (priorDraft !== undefined) {
  const destination = join(taskSource, 'source/prior-candidate'); await mkdir(destination, { recursive: false });
  for (const name of ['assessment-reference.json', 'submission-mapping.json', 'marking-candidate.json']) await cp(join(priorDraft, name), join(destination, name), { force: false, errorOnExist: true });
}
const advisory = ' Before finishing, run python3 -B /task/input/source/self-check/check.py /task/outputs. This uses copies of installed Tutor schema and business validators for local feedback only; it does not issue a host Gate receipt or judge semantic scoring. Fix reported defects without weakening the check. In particular, do not reuse the same page-region box across different items; inspect images and select distinct tight evidence for each part. Do not generate __pycache__ inside the protected source tree.';
const markerPrompt = prompts.markerPrompt + imageRoles + advisory + (priorDraft === undefined ? '' : ' A previous failed execution wrote unaccepted drafts now provided in /task/input/source/prior-candidate. Inspect them against the original source and visible student work, correct supported defects, and deliver fresh copies at /task/outputs/candidate. Preserve the original drafts unchanged within the source tree. Do not regenerate correct content unnecessarily. Old files are not evidence of acceptance: a fresh normal completion and all host Gates are required.');
const summary = await runMarkingAcceptance({ root, source: taskSource, tutorWorkspace: workspace, python, context, confirmSubmission,
  ...(priorDraft === undefined ? {} : { draftRun: priorDraft }),
  syntheticMaterial: false, realModels: true, maxSourceBytes, toolTimeoutMs: 300000,
  marker: { id: 'codex-marker', prompt: markerPrompt, config }, reviewer: { id: 'codex-reviewer', prompt: prompts.reviewerPrompt + imageRoles + advisory, config },
  reporter: { id: 'codex-reporter', prompt: prompts.reporterPrompt, config: selected.config }, driver: store => selected.driver(store, root) });
console.log(JSON.stringify(summary)); process.exitCode = summary.passed ? 0 : 1;
