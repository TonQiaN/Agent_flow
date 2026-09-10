import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner } from '@agentflow/engine';
import type { Cancellation, CredentialIdentity, CredentialStore, HarnessAdapter, HarnessPlan, HarnessResult, HarnessTask, RunnerResult, Invocation } from '@agentflow/engine';
import type { SystemConfigMount } from '../docker/backend.js';
import { DockerBackend } from '../docker/backend.js';
import { docker } from '../docker/process.js';
import { EnvironmentExecutionCredentialBinding } from '../auth/environment-binding.js';
import { FileExecutionCredentialBinding } from '../auth/execution-binding.js';
import type { BindingFinalization, ExecutionCredentialBinding } from '../auth/execution-binding.js';
import { readCapturedBytes } from './capture-reader.js';
import { systemClock } from '../system-clock.js';


export interface CredentialRedactor { remember(content: string): void; redact(text: string): string }
/** Internal trusted host composition, not a workflow configuration or plugin-loading API. */
export type CredentialRecipe<P extends CredentialIdentity> = CredentialRecipeBase<P> & (
  { readonly binding: 'exclusive'; readonly stateFile: string; readonly secretEnvironment?: never }
  | { readonly binding: 'environment'; readonly secretEnvironment: (content: string) => Readonly<Record<string, string>>; readonly stateFile?: never }
);
interface CredentialRecipeBase<P extends CredentialIdentity> {
  readonly memoryMiB?: number;
  readonly version: string; readonly hosts: readonly string[]; readonly versionCommand: readonly string[];
  readonly systemConfigMounts?: readonly SystemConfigMount[];
  adapter(): HarnessAdapter; profile(value: P): P; redactor(): CredentialRedactor;
  parseVersion(stdout: string): string | null;
  stateEnvironment(plan: HarnessPlan): Readonly<Record<string, string>>;
  invocation(plan: HarnessPlan): Pick<Invocation, 'argv' | 'configFiles' | 'recordFiles'>;
}

export interface CredentialRunRequest<P extends CredentialIdentity> {
  readonly task: HarnessTask; readonly profile: P; readonly inputSource: string; readonly timeoutMs: number;
}
export interface CredentialExecutionResult {
  readonly stage: 'version' | 'execution';
  readonly runner: RunnerResult;
  readonly harness: HarnessResult | null;
  readonly authentication: BindingFinalization | null;
  readonly version: { readonly expected: string; readonly actual: string | null; readonly imageId: string };
  readonly diagnostics: readonly string[];
}

/** Environment composition. Engine Runner and the pure Adapter have no provider-auth branches. */
export class CredentialHarnessRunner<P extends CredentialIdentity> {
  readonly #store: CredentialStore;
  readonly #options: { workspaceRoot: string; image: string; proxyImage: string };
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }, private readonly recipe: CredentialRecipe<P>) {
    if (!options || Object.keys(options).sort().join(',') !== 'image,proxyImage,workspaceRoot') throw new Error('INVALID_SUBSCRIPTION_RUNNER');
    // Validate host choices before any credential lease or owned execution exists.
    new DockerBackend({ image: options.image, workspaceRoot: options.workspaceRoot, sandbox: 'nested-userns-v1',
      ...(recipe.memoryMiB ? { memoryMiB: recipe.memoryMiB } : {}),
      ...(recipe.systemConfigMounts ? { systemConfigMounts: recipe.systemConfigMounts } : {}),
      network: { kind: 'connect-proxy', proxyImage: options.proxyImage, allowedHosts: this.recipe.hosts } });
    this.#store = store; this.#options = Object.freeze({ ...options });
  }

  async run(request: CredentialRunRequest<P>, cancellation: Cancellation = { requested: () => false }): Promise<CredentialExecution> {
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
      && probe.capture?.imageId === imageId && [probe.capture.stdout, probe.capture.stderr].every(file => file.complete && !file.truncated && !file.error)) {
      try { actual = this.recipe.parseVersion(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readCapturedBytes(probe.capture.stdout, 16 * 1024 * 1024))); } catch { /* Static mismatch below. */ }
    }
    const version = Object.freeze({ expected: this.recipe.version, actual, imageId });
    if (actual !== this.recipe.version) return new CredentialExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['HARNESS_VERSION_NOT_VERIFIED']);
    try { if (probe.resource) await probeRunner.release(probe.resource); }
    catch { return new CredentialExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['VERSION_WORKSPACE_RELEASE_FAILED']); }

    const redactor = this.recipe.redactor();
    const credential = { credentialRef: profile.credentialRef, service: profile.service, method: profile.method };
    const binding = this.recipe.binding === 'environment'
      ? await EnvironmentExecutionCredentialBinding.acquire(this.#store, { identity: task.identity, credential }, this.recipe.secretEnvironment, 0, content => redactor.remember(content))
      : await FileExecutionCredentialBinding.acquire(
        this.#store, { identity: task.identity, credential, stateFile: this.recipe.stateFile, environment: this.recipe.stateEnvironment(plan) }, 0, content => redactor.remember(content));
    let backend: DockerBackend; let runner: Runner; let result: RunnerResult;
    try {
      backend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: imageId, sandbox: 'nested-userns-v1',
        ...(this.recipe.memoryMiB ? { memoryMiB: this.recipe.memoryMiB } : {}),
        ...(this.recipe.systemConfigMounts ? { systemConfigMounts: this.recipe.systemConfigMounts } : {}),
        network: { kind: 'connect-proxy', proxyImage: this.#options.proxyImage, allowedHosts: this.recipe.hosts } }, binding);
      runner = new Runner(backend, systemClock);
      result = await runner.run({ identity: task.identity, inputSource, timeoutMs, invocation }, cancellation);
    } catch { await binding.abandon(); throw new Error('SUBSCRIPTION_EXECUTION_NOT_PREPARED'); }
    const execution = new CredentialExecution('execution', result, backend, runner, version, binding, redactor, task, [], adapter, invocation.recordFiles ?? []);
    await execution.interpret(); return execution;
  }
}

/** Keeps cleanup capabilities alive when stop or credential finalization is uncertain. Public views are copies. */
export class CredentialExecution {
  #result: RunnerResult;
  #authentication: BindingFinalization | null = null;
  #harness: HarnessResult | null = null;
  readonly #diagnostics: string[];
  readonly #stage: CredentialExecutionResult['stage'];
  readonly #backend: DockerBackend;
  readonly #runner: Runner;
  readonly #version: CredentialExecutionResult['version'];
  readonly #binding: ExecutionCredentialBinding | null;
  readonly #redactor: CredentialRedactor | null;
  readonly #task: HarnessTask | null;
  #interpreted = false;
  constructor(stage: CredentialExecutionResult['stage'], result: RunnerResult, backend: DockerBackend, runner: Runner,
    version: CredentialExecutionResult['version'], binding: ExecutionCredentialBinding | null, redactor: CredentialRedactor | null,
    task: HarnessTask | null, diagnostics: string[], private readonly adapter?: HarnessAdapter, private readonly recordFiles: NonNullable<Invocation['recordFiles']> = []) {
    this.#stage = stage; this.#result = result; this.#backend = backend; this.#runner = runner; this.#version = version;
    this.#binding = binding; this.#redactor = redactor; this.#task = task; this.#diagnostics = diagnostics;
  }
  get result(): CredentialExecutionResult {
    return structuredClone({ stage: this.#stage, runner: this.#result, harness: this.#harness, authentication: this.#authentication,
      version: this.#version, diagnostics: this.#diagnostics });
  }
  toJSON(): CredentialExecutionResult { return this.result; }
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
      const stdout = this.#result.capture.stdout.complete ? await readCapturedBytes(this.#result.capture.stdout, 16 * 1024 * 1024) : new Uint8Array();
      const records: Record<string, Uint8Array> = {};
      for (const spec of this.recordFiles) {
        const file = this.#result.capture.files[spec.id];
        if (file?.complete && !file.truncated && !file.error) records[spec.id] = await readCapturedBytes(file, spec.maxBytes);
      }
      this.#harness = this.adapter!.interpret({ task: this.#task, runner: this.#result, version: this.#version.actual!, stdout, records, redact: value => this.#redactor!.redact(value) });
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
