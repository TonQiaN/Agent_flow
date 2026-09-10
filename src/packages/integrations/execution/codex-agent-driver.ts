import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ArtifactError } from '@agentflow/engine';
import type { AgentExecutionDriver, AgentExecutionFacts, AgentExecutionHandle, ArtifactStore, Cancellation, FileManifest, HarnessTask } from '@agentflow/engine';
import { CodexAdapter } from '../harness/codex.js';
import { codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import { CodexSubscriptionRunner } from './codex-runner.js';
import type { CodexExecution } from './codex-runner.js';

/** Composition bridge: provider/auth details stay outside the portable acceptance engine. */
export class CodexAgentDriver implements AgentExecutionDriver {
  readonly harness = 'codex';
  readonly #profile: CodexSubscriptionProfile;
  readonly #options: { inputRoot: string; timeoutMs: number };
  constructor(private readonly runtime: CodexSubscriptionRunner, private readonly artifacts: ArtifactStore,
    profile: CodexSubscriptionProfile, options: { inputRoot: string; timeoutMs: number }) {
    this.#profile = codexSubscriptionProfile(profile);
    if (!options || Object.keys(options).sort().join(',') !== 'inputRoot,timeoutMs' || !isAbsolute(options.inputRoot)
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000) throw new Error('INVALID_CODEX_DRIVER');
    this.#options = Object.freeze({ ...options });
  }
  validate(task: HarnessTask): void { new CodexAdapter().plan(task); }
  async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation): Promise<AgentExecutionHandle> {
    this.validate(task);
    await mkdir(this.#options.inputRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.#options.inputRoot, 'input-'));
    let execution: CodexExecution;
    try {
      const inputSource = join(root, 'files'); await this.artifacts.materialize(input.id, inputSource);
      execution = await this.runtime.run({ task, profile: this.#profile, inputSource, timeoutMs: this.#options.timeoutMs }, cancellation);
    } catch (error) { await rm(root, { recursive: true, force: true }); if (error instanceof ArtifactError) throw error; throw new Error('CODEX_AGENT_START_FAILED'); }
    return new CodexAgentHandle(execution, root);
  }
}

class CodexAgentHandle implements AgentExecutionHandle {
  constructor(private readonly execution: CodexExecution, private readonly inputRoot: string) {}
  get facts(): AgentExecutionFacts {
    const result = this.execution.result;
    return { runner: result.runner, harness: result.harness, version: result.version.actual,
      finalized: result.stage === 'execution' && result.authentication?.status === 'released'
        && (result.authentication.refresh === 'unchanged' || result.authentication.refresh === 'updated'),
      diagnostics: result.diagnostics };
  }
  async retryCleanup(): Promise<void> { await this.execution.retryCleanup(); }
  async release(): Promise<void> { await this.execution.release(); await rm(this.inputRoot, { recursive: true, force: true }); }
}
