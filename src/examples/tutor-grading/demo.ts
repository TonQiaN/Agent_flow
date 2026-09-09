import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createGradingFixture } from './flow.js';

// The optional destination must be new. No network, model, student records or production writes.
const destination = resolve(process.argv[2] ?? 'tutor-fixture-result');
await mkdir(destination, { mode: 0o700 });
const root = await mkdtemp(join(tmpdir(), 'af-tutor-demo-'));
try {
  const fixture = await createGradingFixture(root), run = await fixture.run('fixture-demo');
  try {
    const gate = run.snapshot.steps.findLast(s => s.node === 'gate')?.result;
    if (run.snapshot.outcome !== 'published' || gate?.status !== 'accepted') throw new Error('FIXTURE_GRADING_FAILED');
    const bundle = join(root, 'accepted'); await fixture.files.materialize(gate.output, 'fixture-demo', bundle);
    for (const file of ['candidate.json', 'gate-report.json']) await copyFile(join(bundle, file), join(destination, file));
    process.stdout.write(JSON.stringify({ fixture: true, status: run.snapshot.status, outcome: run.snapshot.outcome,
      nodes: run.snapshot.steps.map(s => s.node), serviceWrites: fixture.service.writes, destination }) + '\n');
  } finally { await fixture.release(run); }
} finally { await rm(root, { recursive: true, force: true }); }
