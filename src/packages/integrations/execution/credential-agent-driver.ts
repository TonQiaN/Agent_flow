import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ArtifactError } from '@agentflow/engine';
import type { CredentialIdentity, HarnessAdapter, AgentExecutionDriver, AgentExecutionFacts, AgentExecutionHandle, ArtifactStore, Cancellation, FileManifest, HarnessTask } from '@agentflow/engine';
import type { CredentialHarnessRunner } from './credential-runner.js';
import type { CredentialExecution } from './credential-runner.js';

/** Composition bridge: provider/auth details stay outside the portable acceptance engine. */
export class CredentialAgentDriver<P extends CredentialIdentity> implements AgentExecutionDriver {
  readonly harness: string;
  readonly #profile: P;
  readonly #options: { inputRoot: string; timeoutMs: number };
  constructor(private readonly runtime: CredentialHarnessRunner<P>, private readonly artifacts: ArtifactStore,
    profile: P, options: { inputRoot: string; timeoutMs: number }, private readonly adapter: HarnessAdapter) {
    this.#profile = profile; this.harness = adapter.id;
    if (!options || Object.keys(options).sort().join(',') !== 'inputRoot,timeoutMs' || !isAbsolute(options.inputRoot)
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000) throw new Error('INVALID_SUBSCRIPTION_DRIVER');
    this.#options = Object.freeze({ ...options });
  }
  validate(task: HarnessTask): void { this.adapter.plan(task); }
  async run(task: HarnessTask, input: FileManifest, cancellation: Cancellation): Promise<AgentExecutionHandle> {
    this.validate(task);
    await mkdir(this.#options.inputRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.#options.inputRoot, 'input-'));
    let execution: CredentialExecution;
    try {
      const inputSource = join(root, 'files'); await this.artifacts.materialize(input.id, inputSource);
      execution = await this.runtime.run({ task, profile: this.#profile, inputSource, timeoutMs: this.#options.timeoutMs }, cancellation);
    } catch (error) { await rm(root, { recursive: true, force: true }); if (error instanceof ArtifactError) throw error; throw new Error('SUBSCRIPTION_AGENT_START_FAILED'); }
    return new CredentialAgentHandle(execution, root);
  }
}

class CredentialAgentHandle implements AgentExecutionHandle {
  constructor(private readonly execution: CredentialExecution, private readonly inputRoot: string) {}
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
