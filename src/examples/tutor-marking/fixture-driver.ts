import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentExecutionDriver, AgentExecutionFacts, ArtifactStore, FileManifest, HarnessTask } from '@agentflow/engine';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type MarkingFixtureMode = 'correct' | 'reject' | 'stale-hash' | 'low-quality' | 'failed-check' | 'source-tamper' | 'review-tamper' | 'invalid-candidate';
/** Separate canned Marker and Reviewer invocations. No model quality claim. */
export class TutorMarkingFixtureDriver implements AgentExecutionDriver {
  readonly harness = 'tutor-marking-fixture';
  readonly tasks: HarnessTask[] = [];
  readonly live = new Set<string>();
  constructor(private readonly store: ArtifactStore, private readonly root: string, private readonly seed: string) {}
  validate(task: HarnessTask) {
    const config = task.config as { role: string; mode: MarkingFixtureMode };
    if (!['marker', 'reviewer', 'repair'].includes(config.role) || !['correct', 'reject', 'stale-hash', 'low-quality', 'failed-check', 'source-tamper', 'review-tamper', 'invalid-candidate'].includes(config.mode)) throw new Error('INVALID_MARKING_FIXTURE');
  }
  async run(task: HarnessTask, input: FileManifest) {
    await mkdir(this.root, { recursive: true });
    const root = await mkdtemp(join(this.root, 'marking-fixture-')); this.live.add(root); this.tasks.push(task);
    try {
      const incoming = join(root, 'input'), output = join(root, 'outputs');
      await this.store.materialize(input.id, incoming); await cp(incoming, output, { recursive: true });
      const { role, mode } = task.config as { role: string; mode: MarkingFixtureMode };
      if (role === 'marker') {
        await cp(this.seed, join(output, 'candidate'), { recursive: true });
        if (mode === 'invalid-candidate') {
          const path = join(output, 'candidate/marking-candidate.json'), candidate = JSON.parse(await readFile(path, 'utf8'));
          candidate.total_score = 100; await writeFile(path, JSON.stringify(candidate));
        }
      } else {
        if (mode === 'correct') {
          const path = join(output, 'candidate/marking-candidate.json'), candidate = JSON.parse(await readFile(path, 'utf8'));
          candidate.item_results[0].feedback.summary = 'Correct differentiation; independently checked in a synthetic review.';
          await writeFile(path, JSON.stringify(candidate));
        }
        const reviewPath = join(output, 'trusted/marking-review-input.json');
        const review = JSON.parse(await readFile(reviewPath, 'utf8'));
        if (mode === 'review-tamper') { review.policy.minimum_accept_score = 0; await writeFile(reviewPath, JSON.stringify(review)); }
        const checks = Object.fromEntries(['reference', 'mapping', 'coverage', 'rubric', 'scoring', 'evidence', 'feedback'].map(k => [k, 'PASS']));
        if (mode === 'failed-check') checks.scoring = 'FAIL';
        const reviewer = { schema_version: 1, contract_version: 'exam-marking-reviewer-result/v1',
          review_input_sha256: hash(await readFile(reviewPath)), reviewed_candidate_sha256: review.candidate.sha256,
          final_candidate_sha256: mode === 'stale-hash' ? '0'.repeat(64) : hash(await readFile(join(output, 'candidate/marking-candidate.json'))),
          decision: mode === 'reject' ? 'REJECT' : 'ACCEPT', quality_score: mode === 'low-quality' ? 0 : 1, checks, findings: [],
          change_summary: 'Synthetic separate review invocation. No student or model quality evidence.' };
        await writeFile(join(output, 'trusted/marking-reviewer-result.json'), JSON.stringify(reviewer));
      }
      if (mode === 'source-tamper') await writeFile(join(output, 'source/input/source/paper.pdf'), 'changed source');
      // Local input editing is allowed and must not affect the captured original.
      await writeFile(join(incoming, 'source/input/marking-input.json'), '{}');
      await writeFile(join(root, 'stdout'), 'fixture completed'); await writeFile(join(root, 'stderr'), '');
      const facts: AgentExecutionFacts = { runner: { identity: task.identity, resource: { id: 'fixture-marking' }, phase: 'exited', exitCode: 0, stop: 'confirmed', cleanup: 'removed',
        capture: { imageId: null, outputsPath: output, files: {}, stdout: { path: join(root, 'stdout'), bytes: 17, complete: true, truncated: false }, stderr: { path: join(root, 'stderr'), bytes: 0, complete: true, truncated: false } },
        diagnostics: [], startedAt: 0, finishedAt: 1 }, harness: { identity: task.identity, harness: this.harness, status: 'completed', outcome: null, events: [], diagnostics: [],
          usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }, version: 'fixture-v1', finalized: true, diagnostics: [] };
      return { facts, async retryCleanup() {}, release: async () => { await rm(root, { recursive: true, force: true }); this.live.delete(root); } };
    } catch (error) { await rm(root, { recursive: true, force: true }); this.live.delete(root); throw error; }
  }
}
