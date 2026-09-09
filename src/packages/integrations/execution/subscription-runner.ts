import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner } from '@agentflow/engine';
import type { Cancellation, CredentialIdentity, CredentialStore, HarnessAdapter, HarnessPlan, HarnessResult, HarnessTask, RunnerResult } from '@agentflow/engine';
import { DockerBackend } from '../docker/backend.js';
import { docker } from '../docker/process.js';
import { FileExecutionCredentialBinding } from '../auth/execution-binding.js';
import type { BindingFinalization } from '../auth/execution-binding.js';
import { systemClock } from '../system-clock.js';


export interface SubscriptionRedactor { remember(content: string): void; redact(text: string): string }
/** Internal trusted host composition, not a workflow configuration or plugin-loading API. */
export interface SubscriptionRecipe<P extends CredentialIdentity> {
  readonly version: string; readonly hosts: readonly string[]; readonly stateFile: string; readonly versionCommand: readonly string[];
  adapter(): HarnessAdapter; profile(value: P): P; redactor(): SubscriptionRedactor;
  parseVersion(stdout: string): string | null;
  stateEnvironment(plan: HarnessPlan): Readonly<Record<string, string>>;
  invocation(plan: HarnessPlan): { argv: readonly string[]; configFiles: HarnessPlan['configFiles'] };
}

export interface SubscriptionRunRequest<P extends CredentialIdentity> {
  readonly task: HarnessTask; readonly profile: P; readonly inputSource: string; readonly timeoutMs: number;
}
export interface SubscriptionExecutionResult {
  readonly stage: 'version' | 'execution';
  readonly runner: RunnerResult;
  readonly harness: HarnessResult | null;
  readonly authentication: BindingFinalization | null;
  readonly version: { readonly expected: string; readonly actual: string | null; readonly imageId: string };
  readonly diagnostics: readonly string[];
}

/** Environment composition. Engine Runner and the pure Adapter have no provider-auth branches. */
export class SubscriptionHarnessRunner<P extends CredentialIdentity> {
  readonly #store: CredentialStore;
  readonly #options: { workspaceRoot: string; image: string; proxyImage: string };
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }, private readonly recipe: SubscriptionRecipe<P>) {
    if (!options || Object.keys(options).sort().join(',') !== 'image,proxyImage,workspaceRoot') throw new Error('INVALID_SUBSCRIPTION_RUNNER');
    // Validate host choices before any credential lease or owned execution exists.
    new DockerBackend({ image: options.image, workspaceRoot: options.workspaceRoot, sandbox: 'nested-userns-v1',
      network: { kind: 'connect-proxy', proxyImage: options.proxyImage, allowedHosts: this.recipe.hosts } });
    this.#store = store; this.#options = Object.freeze({ ...options });
  }

  async run(request: SubscriptionRunRequest<P>, cancellation: Cancellation = { requested: () => false }): Promise<SubscriptionExecution> {
    let task: HarnessTask;
    try { task = structuredClone(request.task); } catch { throw new Error('INVALID_HARNESS_TASK'); }
    const adapter = this.recipe.adapter(); const plan = adapter.plan(task);
    const invocation = this.recipe.invocation(plan);
    const profile = this.recipe.profile(request.profile);
    const inputSource = request.inputSource; const timeoutMs = request.timeoutMs;
    if (Object.keys(request).sort().join(',') !== 'inputSource,profile,task,timeoutMs' || typeof inputSource !== 'string'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
    const probeBackend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: imageId });
    const probeRunner = new Runner(probeBackend, systemClock);
    await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
    const empty = await mkdtemp(join(this.#options.workspaceRoot, 'version-input-'));
    let probe: RunnerResult;
    try { probe = await probeRunner.run({ identity: task.identity, inputSource: empty, timeoutMs: 10_000, invocation: { argv: this.recipe.versionCommand } }, cancellation); }
    finally { await rm(empty, { recursive: true, force: true }); }
    let actual: string | null = null;
    if (probe.phase === 'exited' && probe.exitCode === 0 && probe.stop === 'confirmed' && probe.cleanup === 'removed'
      && probe.capture?.imageId === imageId && probe.capture.stdout.complete && probe.capture.stderr.complete) {
      try { actual = this.recipe.parseVersion(await readFile(probe.capture.stdout.path, 'utf8')); } catch { /* Static mismatch below. */ }
    }
    const version = Object.freeze({ expected: this.recipe.version, actual, imageId });
    if (actual !== this.recipe.version) return new SubscriptionExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['HARNESS_VERSION_NOT_VERIFIED']);
    try { if (probe.resource) await probeRunner.release(probe.resource); }
    catch { return new SubscriptionExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['VERSION_WORKSPACE_RELEASE_FAILED']); }

    const redactor = this.recipe.redactor();
    const binding = await FileExecutionCredentialBinding.acquire(this.#store, { identity: task.identity,
      credential: { credentialRef: profile.credentialRef, service: profile.service, method: profile.method },
      stateFile: this.recipe.stateFile, environment: this.recipe.stateEnvironment(plan) }, 0, content => redactor.remember(content));
    let backend: DockerBackend; let runner: Runner; let result: RunnerResult;
    try {
      backend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: imageId, sandbox: 'nested-userns-v1',
        network: { kind: 'connect-proxy', proxyImage: this.#options.proxyImage, allowedHosts: this.recipe.hosts } }, binding);
      runner = new Runner(backend, systemClock);
      result = await runner.run({ identity: task.identity, inputSource, timeoutMs, invocation }, cancellation);
    } catch { await binding.abandon(); throw new Error('SUBSCRIPTION_EXECUTION_NOT_PREPARED'); }
    const execution = new SubscriptionExecution('execution', result, backend, runner, version, binding, redactor, task, [], adapter);
    await execution.interpret(); return execution;
  }
}

/** Keeps cleanup capabilities alive when stop or credential finalization is uncertain. Public views are copies. */
export class SubscriptionExecution {
  #result: RunnerResult;
  #authentication: BindingFinalization | null = null;
  #harness: HarnessResult | null = null;
  readonly #diagnostics: string[];
  readonly #stage: SubscriptionExecutionResult['stage'];
  readonly #backend: DockerBackend;
  readonly #runner: Runner;
  readonly #version: SubscriptionExecutionResult['version'];
  readonly #binding: FileExecutionCredentialBinding | null;
  readonly #redactor: SubscriptionRedactor | null;
  readonly #task: HarnessTask | null;
  #interpreted = false;
  constructor(stage: SubscriptionExecutionResult['stage'], result: RunnerResult, backend: DockerBackend, runner: Runner,
    version: SubscriptionExecutionResult['version'], binding: FileExecutionCredentialBinding | null, redactor: SubscriptionRedactor | null,
    task: HarnessTask | null, diagnostics: string[], private readonly adapter?: HarnessAdapter) {
    this.#stage = stage; this.#result = result; this.#backend = backend; this.#runner = runner; this.#version = version;
    this.#binding = binding; this.#redactor = redactor; this.#task = task; this.#diagnostics = diagnostics;
  }
  get result(): SubscriptionExecutionResult {
    return structuredClone({ stage: this.#stage, runner: this.#result, harness: this.#harness, authentication: this.#authentication,
      version: this.#version, diagnostics: this.#diagnostics });
  }
  toJSON(): SubscriptionExecutionResult { return this.result; }
  async #finalize(): Promise<void> {
    if (!this.#binding) return;
    try { this.#authentication = await this.#binding.finish(this.#result); }
    catch { this.#diagnostics.push('CREDENTIAL_FINALIZATION_FAILED'); }
  }
  async interpret(): Promise<void> {
    if (this.#interpreted) return;
    this.#interpreted = true; await this.#finalize();
    if (!this.#task || !this.#redactor || this.#authentication?.status !== 'released' || this.#authentication.refresh === 'failed') {
      this.#diagnostics.push('AUTHENTICATION_NOT_FINALIZED'); return;
    }
    if (this.#result.capture?.imageId !== this.#version.imageId) { this.#diagnostics.push('EXECUTION_IMAGE_MISMATCH'); return; }
    try {
      const stdout = this.#result.capture.stdout.complete ? await readFile(this.#result.capture.stdout.path) : new Uint8Array();
      this.#harness = this.adapter!.interpret({ task: this.#task, runner: this.#result, version: this.#version.actual!, stdout, redact: value => this.#redactor!.redact(value) });
    } catch { this.#diagnostics.push('HARNESS_INTERPRETATION_FAILED'); }
  }
  async retryCleanup(): Promise<void> {
    const resource = this.#result.resource;
    if (resource && this.#result.cleanup !== 'removed') {
      if (!(await this.#backend.stop(resource)).confirmed) throw new Error('EXECUTION_STOP_UNCONFIRMED');
      await this.#backend.remove(resource);
      this.#result = { ...this.#result, stop: 'confirmed', cleanup: 'removed' };
    }
    await this.#finalize(); // Cleanup recovery never upgrades the original Harness/business result.
  }
  async release(): Promise<void> {
    if (this.#binding && this.#authentication?.status !== 'released') throw new Error('CREDENTIAL_BINDING_RETAINED');
    if (this.#result.resource) await this.#runner.release(this.#result.resource);
  }
}
