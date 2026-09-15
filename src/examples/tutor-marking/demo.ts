import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTutorMarkingApplication, prepareMarkedReportSource } from './application.js';
import { TutorMarkingFixtureDriver } from './fixture-driver.js';
import { createTutorReportApplication } from '../tutor-report/application.js';
import { TutorReportFixtureDriver, fixtureContext, fixtureProgram } from '../tutor-report/fixture-driver.js';
const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;
if (!workspace || !python || !process.argv[2]) throw new Error('Provide TUTOR_WORKSPACE, TUTOR_PYTHON and a new output directory');
const output = resolve(process.argv[2]); await mkdir(output, { recursive: false, mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'af-scanned-demo-'));
try {
  await promisify(execFile)(python, [fixtureProgram, 'source', '--workspace', workspace, '--output', join(root, 'fixture')],
    { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  await mkdir(join(root, 'source')); await cp(join(root, 'fixture/source'), join(root, 'source/source'), { recursive: true });
  const app = await createTutorMarkingApplication(join(root, 'marking'), { source: join(root, 'source'), tutorWorkspace: workspace, python,
    marker: { id: 'synthetic-marker', prompt: 'Synthetic marker fixture', config: { role: 'marker', mode: 'correct' } },
    reviewer: { id: 'synthetic-reviewer', prompt: 'Synthetic reviewer fixture', config: { role: 'reviewer', mode: 'correct' } },
    driver: store => new TutorMarkingFixtureDriver(store, join(root, 'agents'), join(root, 'fixture/candidate')) });
  const marked = await app.run('synthetic-scanned-marking');
  try {
    await writeFile(join(output, 'marking-workflow.json'), JSON.stringify(marked.snapshot, null, 2));
    await app.exportMarked(marked.snapshot.runId, join(root, 'accepted'));
    await cp(join(root, 'accepted/trusted'), join(output, 'marking-gates'), { recursive: true });
    await prepareMarkedReportSource(join(root, 'accepted'), join(root, 'report-input'));
    const report = await createTutorReportApplication(join(root, 'reporting'), { source: join(root, 'report-input'), tutorWorkspace: workspace, python, context: fixtureContext,
      reporter: { id: 'synthetic-reporter', prompt: 'Synthetic reporter fixture', config: { mode: 'correct' } },
      driver: store => new TutorReportFixtureDriver(store, join(root, 'report-agents'), workspace, python) });
    const rendered = await report.run('synthetic-scanned-report');
    try {
      await writeFile(join(output, 'report-workflow.json'), JSON.stringify(rendered.snapshot, null, 2));
      const last = rendered.snapshot.lastAccepted?.result;
      if (rendered.snapshot.outcome !== 'completed' || last?.status !== 'accepted') throw new Error('REPORT_FAILED');
      await report.files.materialize(last.output, rendered.snapshot.runId, join(root, 'rendered'));
      for (const name of ['report.pdf', 'report-gate.json', 'report-candidate.json', 'render-manifest.json']) await cp(join(root, 'rendered', name), join(output, name));
      console.log(JSON.stringify({ markingNodes: marked.snapshot.steps.length, reportNodes: rendered.snapshot.steps.length, output, models: 'synthetic fixtures only' }));
    } finally { await report.release(rendered); }
  } finally { await app.release(marked); }
} finally { await rm(root, { recursive: true, force: true }); }
