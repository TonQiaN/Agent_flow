/** Real Codex on explicitly synthetic scans; no private student-material discovery. */
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { runMarkingAcceptance } from './acceptance.js';
import { tutorMarkingPrompts } from './prompts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectGradingHarness } from '../tutor-grading/selected-harness.js';
import { fixtureContext, fixtureProgram } from '../tutor-report/fixture-driver.js';
const selected = selectGradingHarness('codex', process.env);
const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;
if (!workspace || !python) throw new Error('TUTOR_INSTALLATION_REQUIRED');
await mkdir(selected.acceptanceRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(selected.acceptanceRoot, 'scanned-codex-'));
const runTool = (program: string, args: string[]) => promisify(execFile)(python, [program, ...args], { timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' } });
const draftRun = process.env.AGENTFLOW_SCANNED_DRAFT_RUN;
if (draftRun !== undefined) {
  // Explicit local synthetic run only; never discover private student bundles or resume a CLI session.
  if (!/^scanned-codex-[A-Za-z0-9]{6}$/.test(draftRun)) throw new Error('INVALID_SYNTHETIC_DRAFT_RUN');
  const prior = join(selected.acceptanceRoot, draftRun);
  const summary = JSON.parse(await readFile(join(prior, 'summary.json'), 'utf8'));
  if (summary.syntheticMaterial !== true || summary.realModels !== true || summary.passed !== false
    || summary.executions.length !== 1 || summary.executions[0].released !== true) throw new Error('INELIGIBLE_SYNTHETIC_DRAFT');
  await cp(join(prior, 'bundle'), join(root, 'bundle'), { recursive: true, errorOnExist: true, force: false });
  const destination = join(root, 'bundle/source/prior-candidate'); await mkdir(destination, { recursive: false });
  for (const name of ['assessment-reference', 'submission-mapping', 'marking-candidate']) {
    await cp(join(prior, 'evidence/real-scanned-marking-task-2/outputs/candidate', `${name}.json`), join(destination, `${name}.json`), { errorOnExist: true, force: false });
  }
} else {
  await runTool(fixtureProgram, ['source', '--workspace', workspace, '--output', join(root, 'fixture')]);
  await mkdir(join(root, 'bundle')); await cp(join(root, 'fixture/source'), join(root, 'bundle/source'), { recursive: true });
  await runTool(fileURLToPath(new URL('./real-source.py', import.meta.url)), [join(root, 'bundle/source')]);
  await runTool(join(workspace, 'agentflows/exam-evaluation/marking/toolchain/prepare_initial_images.py'), ['--input-root', join(root, 'bundle'), '--output-root', join(root, 'bundle/source/prompt-images')]);
}
const inputImages = (await readdir(join(root, 'bundle/source/prompt-images'))).sort().map(name => `source/prompt-images/${name}`);
const config = { ...selected.config, inputImages };
const prompts = tutorMarkingPrompts({ syntheticMaterial: true, priorDraft: draftRun !== undefined });
const summary = await runMarkingAcceptance({ root, source: join(root, 'bundle'), tutorWorkspace: workspace, python,
  syntheticMaterial: true, realModels: true, ...(draftRun === undefined ? {} : { draftRun }), context: fixtureContext,
  marker: { id: 'codex-marker', prompt: prompts.markerPrompt, config }, reviewer: { id: 'codex-reviewer', prompt: prompts.reviewerPrompt, config },
  reporter: { id: 'codex-reporter', prompt: prompts.reporterPrompt, config: selected.config }, driver: store => selected.driver(store, root) });
console.log(JSON.stringify(summary)); process.exitCode = summary.passed ? 0 : 1;
