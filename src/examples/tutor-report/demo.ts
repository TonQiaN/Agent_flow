import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTutorReportApplication } from './application.js';
import { TutorReportFixtureDriver, fixtureProgram, fixtureContext } from './fixture-driver.js';

const workspace = process.env.TUTOR_WORKSPACE, python = process.env.TUTOR_PYTHON;
if (!workspace || !python || !process.argv[2]) throw new Error('Set TUTOR_WORKSPACE/TUTOR_PYTHON and give a new output directory');
const destination = resolve(process.argv[2]); await mkdir(destination, { mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'af-tutor-report-demo-'));
try {
  await promisify(execFile)(python, [fixtureProgram, 'source', '--workspace', workspace, '--output', join(root, 'bundle')],
    { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const app = await createTutorReportApplication(join(root, 'run'), { tutorWorkspace: workspace, python, source: join(root, 'bundle'), context: fixtureContext,
    reporter: { id: 'reporter', prompt: 'Synthetic Reporter protocol fixture.', config: { mode: 'correct' } },
    driver: store => new TutorReportFixtureDriver(store, join(root, 'agent'), workspace, python) });
  const run = await app.run('report-demo');
  try {
    await writeFile(join(destination, 'workflow.json'), JSON.stringify(run.snapshot, null, 2));
    if (run.snapshot.status !== 'succeeded' || run.snapshot.outcome !== 'completed') throw new Error(`REPORT_DEMO_FAILED:${run.snapshot.reason}`);
    const final = run.snapshot.lastAccepted?.result;
    if (final?.status !== 'accepted') throw new Error('REPORT_NOT_ACCEPTED');
    const accepted = join(root, 'accepted'); await app.files.materialize(final.output, 'report-demo', accepted);
    for (const name of ['report.pdf', 'render-manifest.json', 'report-candidate.json', 'report-gate.json']) await cp(join(accepted, name), join(destination, name));
    console.log(JSON.stringify({ fixture: true, officialModel: false, status: run.snapshot.status, nodes: run.snapshot.steps.map(s => s.node), destination }));
  } finally { await app.release(run); }
} finally { await rm(root, { recursive: true, force: true }); }
