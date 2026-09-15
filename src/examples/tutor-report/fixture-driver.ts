import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentExecutionDriver, AgentExecutionFacts, ArtifactStore, FileManifest, HarnessTask } from '@agentflow/engine';

const execute = promisify(execFile);
export const fixtureProgram = fileURLToPath(new URL('./fixture.py', import.meta.url));
export type ReportFixtureMode = 'correct' | 'bad-report' | 'source-tamper';

/** Canned reporter only. Does not call an official Harness or prove model quality. */
export class TutorReportFixtureDriver implements AgentExecutionDriver {
  readonly harness = 'tutor-report-fixture';
  readonly live = new Set<string>();
  readonly tasks: HarnessTask[] = [];
  constructor(private readonly store: ArtifactStore, private readonly root: string, private readonly workspace: string, private readonly python: string) {}
  validate(task: HarnessTask): void {
    if (!['correct', 'bad-report', 'source-tamper'].includes((task.config as { mode: string }).mode)) throw new Error('INVALID_REPORT_FIXTURE');
  }
  async run(task: HarnessTask, input: FileManifest) {
    await mkdir(this.root, { recursive: true });
    const root = await mkdtemp(join(this.root, 'report-fixture-')); this.live.add(root); this.tasks.push(task);
    try {
      await this.store.materialize(input.id, join(root, 'input'));
      await cp(join(root, 'input'), join(root, 'outputs'), { recursive: true });
      await execute(this.python, [fixtureProgram, 'report', '--workspace', this.workspace, '--input', join(root, 'input'), '--output', join(root, 'outputs')],
        { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      const mode = (task.config as { mode: ReportFixtureMode }).mode;
      if (mode === 'bad-report') {
        const path = join(root, 'outputs/report-candidate.json'), candidate = JSON.parse(await readFile(path, 'utf8'));
        candidate.metrics_snapshot_sha256 = '0'.repeat(64); await writeFile(path, JSON.stringify(candidate));
      }
      if (mode === 'source-tamper') await writeFile(join(root, 'outputs/report-source/input/metrics/metrics-snapshot.json'), '{}');
      await writeFile(join(root, 'stdout'), 'synthetic reporter completed'); await writeFile(join(root, 'stderr'), '');
      const facts: AgentExecutionFacts = { runner: { identity: task.identity, resource: { id: 'fixture-report' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
        capture: { imageId: null, outputsPath: join(root, 'outputs'), files: {}, stdout: { path: join(root, 'stdout'), bytes: 28, complete: true, truncated: false },
          stderr: { path: join(root, 'stderr'), bytes: 0, complete: true, truncated: false } }, diagnostics: [], startedAt: 0, finishedAt: 1 },
        harness: { identity: task.identity, harness: this.harness, status: 'completed', outcome: null, events: [], diagnostics: [],
          usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }, version: 'fixture-v1', finalized: true, diagnostics: [] };
      return { facts, async retryCleanup() {}, release: async () => { await rm(root, { recursive: true, force: true }); this.live.delete(root); } };
    } catch (error) { await rm(root, { recursive: true, force: true }); this.live.delete(root); throw error; }
  }
}

export const fixtureContext = { reportId: '019fc800-0000-7000-8000-000000000020', title: 'Synthetic calculus report', studentName: 'Synthetic Student',
  courseName: 'Calculus', assessmentName: 'Consumer acceptance sample', examYear: 2026, authority: 'FIXTURE', jurisdiction: 'TEST' };
