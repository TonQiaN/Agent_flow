import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentExecutionDriver, AgentExecutionFacts, ArtifactStore, FileManifest, HarnessTask } from '@agentflow/engine';

export const fixtureRoot = fileURLToPath(new URL('./fixtures', import.meta.url));
export type FixtureMode = 'correct' | 'wrong' | 'malformed' | 'source-tamper' | 'bad-evidence' | 'stuck';
/** Canned agent answers exercise orchestration; this is explicitly not a real Harness or model. */
export class GradingFixtureDriver implements AgentExecutionDriver {
  readonly harness = 'fixture-agent';
  readonly tasks: HarnessTask[] = [];
  readonly live = new Set<string>();
  constructor(private readonly artifacts: ArtifactStore, private readonly root: string) {}
  validate(task: HarnessTask): void {
    const config = task.config as { mode?: string };
    if (!config || Object.keys(config).join(',') !== 'mode' || !['correct', 'wrong', 'malformed', 'source-tamper', 'bad-evidence', 'stuck'].includes(config.mode ?? '') || task.outcomes) throw new Error('INVALID_FIXTURE_TASK');
  }
  async run(task: HarnessTask, input: FileManifest) {
    this.tasks.push(structuredClone(task)); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.root, 'fixture-')); this.live.add(root);
    try {
      await this.artifacts.materialize(input.id, join(root, 'input')); await cp(join(root, 'input'), join(root, 'outputs'), { recursive: true, errorOnExist: true, force: false });
      const mode = (task.config as { mode: FixtureMode }).mode;
      let text = await readFile(join(fixtureRoot, ['wrong', 'stuck', 'source-tamper'].includes(mode) ? 'wrong.json' : 'correct.json'), 'utf8');
      if (mode === 'malformed') text = '{"invalid":true}';
      if (mode === 'bad-evidence' || mode === 'stuck') {
        const value = JSON.parse(text); if (mode === 'bad-evidence') value.answers[0].evidence.page = 99;
        else value.revision = 999; text = JSON.stringify(value);
      }
      await writeFile(join(root, 'outputs/candidate.json'), text);
      if (mode === 'source-tamper') await writeFile(join(root, 'outputs/source/key.json'), '{"q1":5,"q2":8,"q3":12}');
      // Editing a disposable input is allowed, but does not implicitly change outputs or its source.
      await writeFile(join(root, 'input/source/paper.json'), '{"local":"edited"}');
      const raw = 'fixture completed'; await writeFile(join(root, 'stdout'), raw); await writeFile(join(root, 'stderr'), '');
      const facts: AgentExecutionFacts = { runner: { identity: task.identity, resource: { id: 'fixture-resource' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
        capture: { imageId: null, outputsPath: join(root, 'outputs'), files: {}, stdout: { path: join(root, 'stdout'), bytes: raw.length, complete: true, truncated: false },
          stderr: { path: join(root, 'stderr'), bytes: 0, complete: true, truncated: false } }, diagnostics: [], startedAt: 0, finishedAt: 1 },
        harness: { identity: task.identity, harness: this.harness, status: 'completed', outcome: null, events: [], diagnostics: [],
          usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }, version: '1.0.0', finalized: true, diagnostics: [] };
      return { facts, async retryCleanup() {}, release: async () => { await rm(root, { recursive: true, force: true }); this.live.delete(root); } };
    } catch (error) { await rm(root, { recursive: true, force: true }); this.live.delete(root); throw error; }
  }
}
