import { cp, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { catalogue } from './catalog.js';
import { runRecruitment } from '../recruitment/run.js';
import { createGradingFixture } from '../tutor-grading/fixture.js';
import { createGradingApplication, gradingComponent, gradingWorkflow } from '../tutor-grading/flow.js';
import { createPersistentGradingApplication } from '../tutor-grading/persistent.js';
import { selectGradingHarness, gradingHarness } from '../tutor-grading/selected-harness.js';
import { createTutorMarkingApplication } from '../tutor-marking/application.js';
import { createTutorReportApplication } from '../tutor-report/application.js';
import { tutorMarkingPrompts } from '../tutor-marking/prompts.js';
import { ScriptExecutor } from '@agentflow/engine';
import { SqliteRunRecordStore, SqliteEffectRecordStore, SimulatedEffectService, DockerBackend, FileScriptRecordReader, systemClock, redactView } from '@agentflow/integrations';
const [operation, root, id] = process.argv.slice(2);
if (operation === 'catalogue') { console.log(JSON.stringify(await catalogue())); }
else if (operation === 'run' && root && id) {
  const manifest = JSON.parse(await readFile(join(root, 'input.json'), 'utf8')), runId = id;
  process.env['AGENTFLOW_STUDIO_RUN_ROOT'] = root;
  const key = manifest.workflowId;
  if (key === 'recruitment') await runRecruitment(root, runId, manifest.input);
  else if (['repair-example', 'parallel-map', 'parallel-fork'].includes(key)) {
    const script = key === 'repair-example' ? 'workflow.mjs' : 'json-parallel.mjs', args = key === 'repair-example' ? ['2'] : [key.slice('parallel-'.length)];
    await new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', 'src/examples/' + script, ...args], { env: process.env, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('EXAMPLE_FAILED'))); });
  } else if (key === 'grading-fixture') { const app = await createGradingFixture(join(root, 'work')); const run = await app.run(runId); try { if (run.snapshot.outcome !== 'published') throw new Error('GRADING_FAILED'); } finally { await app.release(run); } }
  else {
    const records = await SqliteRunRecordStore.open(join(root, 'records'));
    try {
      const selected = selectGradingHarness(gradingHarness(process.env['AGENTFLOW_STUDIO_HARNESS'] ?? 'deepseek'), { ...process.env, AGENTFLOW_ACCEPTANCE_ROOT: root }, { timeoutMs: 600000, maxInputBytes: 144 * 1024 ** 2, persistSession: true, events: async event => { await records.appendEvent(event.identity.runId, redactView(event)); } });
      const source = join(root, 'uploads'), work = join(root, 'work'); await mkdir(work, { mode: 0o700 });
      if (key === 'grading-real' || key === 'grading-persistent') {
        const instructions = `Read source/paper.json, source/key.json and source/submission.json. Grade each question by ID. Copy source unchanged into outputs/source. Write outputs/candidate.json exactly as {paperId,studentId,revision,answers:[{questionId,score,evidence:{page,answer}}],total,maxTotal}. Use per-question maxScore for a correct answer, zero otherwise. Every question must occur once. Read gate-report.json when provided, fix all issues and increment revision. Do not write any other files. Do not invent a host gate decision.`;
        const agents = [{ component: gradingComponent('matrix-marker', 'agent', 'source-files', { completed: 'candidate-files' }), prompt: instructions, config: selected.config }, { component: gradingComponent('matrix-fixer', 'agent', 'reviewed-files', { completed: 'candidate-files' }), prompt: instructions, config: selected.config }];
        if (key === 'grading-real') { const app = await createGradingApplication(work, { source: join(source, 'source'), driver: store => selected.driver(store, work), agents, definition: gradingWorkflow({ id: 'real-grading', marker: 'matrix-marker', fixer: 'matrix-fixer', repairs: 1 }) }); const run = await app.run(runId); await app.release(run); }
        else {
          const service = new SimulatedEffectService('studio-local'), app = await createPersistentGradingApplication(work, runId, { records, source, driver: store => selected.driver(store, work), agents, scripts: new ScriptExecutor(new DockerBackend({ workspaceRoot: join(work, 'scripts'), image: 'node:22-bookworm-slim', network: 'none' }), systemClock, new FileScriptRecordReader()), route: { id: 'persistent-grading', marker: 'matrix-marker', fixer: 'matrix-fixer', repairs: 1 }, publication: { target: 'studio-local', key: runId, adapter: service.connect('publish-impl', 'studio-publisher', 'studio-local'), journal: await SqliteEffectRecordStore.open(join(work, 'effects')), allowApply: () => true } });
          await (await app.start()).completion;
        }
      } else if (key === 'tutor-marking' || key === 'tutor-report') {
        const tutorWorkspace = process.env['TUTOR_WORKSPACE'], python = process.env['TUTOR_PYTHON']; if (!tutorWorkspace || !python) throw new Error('TUTOR_NOT_CONFIGURED');
        const prompts = tutorMarkingPrompts({ syntheticMaterial: false });
        if (key === 'tutor-marking') { const app = await createTutorMarkingApplication(work, { source, tutorWorkspace, python, marker: { id: 'marker', prompt: prompts.markerPrompt, config: selected.config }, reviewer: { id: 'reviewer', prompt: prompts.reviewerPrompt, config: selected.config }, repair: { agent: { id: 'reviewer-repair', prompt: prompts.reviewerPrompt, config: selected.config }, maxRounds: 2 }, driver: store => selected.driver(store, work) }); const run = await app.run(runId); await app.release(run); }
        else { const app = await createTutorReportApplication(work, { source, tutorWorkspace, python, context: manifest.input.context, ...(manifest.input.completeness ? { submissionCompleteness: manifest.input.completeness } : {}), reporter: { id: 'model', prompt: prompts.reporterPrompt, config: selected.config }, driver: store => selected.driver(store, work) }); const run = await app.run(runId); await app.release(run); }
      } else throw new Error('UNKNOWN_WORKFLOW');
    } finally { records.close(); }
  }
} else throw new Error('INVALID_STUDIO_ENTRY');
