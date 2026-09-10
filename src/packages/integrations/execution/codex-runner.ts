import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner } from '@agentflow/engine';
import type { Cancellation, CredentialStore, HarnessResult, HarnessTask, RunnerResult } from '@agentflow/engine';
import { DockerBackend } from '../docker/backend.js';
import { docker } from '../docker/process.js';
import { CodexAdapter, CODEX_VERSION } from '../harness/codex.js';
import { FileExecutionCredentialBinding } from '../auth/execution-binding.js';
import type { BindingFinalization } from '../auth/execution-binding.js';
import { CODEX_SUBSCRIPTION_HOSTS, CodexCredentialRedactor, codexSubscriptionProfile } from '../auth/codex-subscription.js';
import type { CodexSubscriptionProfile } from '../auth/codex-subscription.js';
import { systemClock } from '../system-clock.js';

export interface CodexRunRequest {
  readonly task: HarnessTask; readonly profile: CodexSubscriptionProfile; readonly inputSource: string; readonly timeoutMs: number;
}
export interface CodexExecutionResult {
  readonly stage: 'version' | 'execution';
  readonly runner: RunnerResult;
  readonly harness: HarnessResult | null;
  readonly authentication: BindingFinalization | null;
  readonly version: { readonly expected: string; readonly actual: string | null; readonly imageId: string };
  readonly diagnostics: readonly string[];
}

/** Environment composition. Engine Runner and the pure Adapter have no provider-auth branches. */
export class CodexSubscriptionRunner {
  readonly #store: CredentialStore;
  readonly #options: { workspaceRoot: string; image: string; proxyImage: string };
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }) {
    if (!options || Object.keys(options).sort().join(',') !== 'image,proxyImage,workspaceRoot') throw new Error('INVALID_CODEX_RUNNER');
    // Validate host choices before any credential lease or owned execution exists.
    new DockerBackend({ image: options.image, workspaceRoot: options.workspaceRoot, sandbox: 'nested-userns-v1',
      network: { kind: 'connect-proxy', proxyImage: options.proxyImage, allowedHosts: CODEX_SUBSCRIPTION_HOSTS } });
    this.#store = store; this.#options = Object.freeze({ ...options });
  }

  async run(request: CodexRunRequest, cancellation: Cancellation = { requested: () => false }): Promise<CodexExecution> {
    let task: HarnessTask;
    try { task = structuredClone(request.task); } catch { throw new Error('INVALID_HARNESS_TASK'); }
    const adapter = new CodexAdapter(); const plan = adapter.plan(task);
    const profile = codexSubscriptionProfile(request.profile);
    const inputSource = request.inputSource; const timeoutMs = request.timeoutMs;
    if (Object.keys(request).sort().join(',') !== 'inputSource,profile,task,timeoutMs' || typeof inputSource !== 'string'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('INVALID_CODEX_REQUEST');
    const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
    const probeBackend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: imageId });
    const probeRunner = new Runner(probeBackend, systemClock);
    await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
    const empty = await mkdtemp(join(this.#options.workspaceRoot, 'version-input-'));
    let probe: RunnerResult;
    try { probe = await probeRunner.run({ identity: task.identity, inputSource: empty, timeoutMs: 10_000, invocation: { argv: ['codex', '--version'] } }, cancellation); }
    finally { await rm(empty, { recursive: true, force: true }); }
    let actual: string | null = null;
    if (probe.phase === 'exited' && probe.exitCode === 0 && probe.stop === 'confirmed' && probe.cleanup === 'removed'
      && probe.capture?.imageId === imageId && probe.capture.stdout.complete && probe.capture.stderr.complete) {
      try { actual = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(await readFile(probe.capture.stdout.path, 'utf8'))?.[1] ?? null; } catch { /* Static mismatch below. */ }
    }
    const version = Object.freeze({ expected: CODEX_VERSION, actual, imageId });
    if (actual !== CODEX_VERSION) return new CodexExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['HARNESS_VERSION_NOT_VERIFIED']);
    try { if (probe.resource) await probeRunner.release(probe.resource); }
    catch { return new CodexExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['VERSION_WORKSPACE_RELEASE_FAILED']); }

    const redactor = new CodexCredentialRedactor();
    const binding = await FileExecutionCredentialBinding.acquire(this.#store, { identity: task.identity,
      credential: { credentialRef: profile.credentialRef, service: profile.service, method: profile.method },
      stateFile: 'codex/auth.json', environment: plan.environment }, 0, content => redactor.remember(content));
    let backend: DockerBackend; let runner: Runner; let result: RunnerResult;
    try {
      backend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: imageId, sandbox: 'nested-userns-v1',
        network: { kind: 'connect-proxy', proxyImage: this.#options.proxyImage, allowedHosts: CODEX_SUBSCRIPTION_HOSTS } }, binding);
      runner = new Runner(backend, systemClock);
      result = await runner.run({ identity: task.identity, inputSource, timeoutMs, invocation: { argv: plan.argv, configFiles: plan.configFiles } }, cancellation);
    } catch { await binding.abandon(); throw new Error('CODEX_EXECUTION_NOT_PREPARED'); }
    const execution = new CodexExecution('execution', result, backend, runner, version, binding, redactor, task, []);
    await execution.interpret(); return execution;
  }
}

/** Keeps cleanup capabilities alive when stop or credential finalization is uncertain. Public views are copies. */
export class CodexExecution {
  #result: RunnerResult;
  #authentication: BindingFinalization | null = null;
  #harness: HarnessResult | null = null;
  readonly #diagnostics: string[];
  readonly #stage: CodexExecutionResult['stage'];
  readonly #backend: DockerBackend;
  readonly #runner: Runner;
  readonly #version: CodexExecutionResult['version'];
  readonly #binding: FileExecutionCredentialBinding | null;
  readonly #redactor: CodexCredentialRedactor | null;
  readonly #task: HarnessTask | null;
  #interpreted = false;
  constructor(stage: CodexExecutionResult['stage'], result: RunnerResult, backend: DockerBackend, runner: Runner,
    version: CodexExecutionResult['version'], binding: FileExecutionCredentialBinding | null, redactor: CodexCredentialRedactor | null,
    task: HarnessTask | null, diagnostics: string[]) {
    this.#stage = stage; this.#result = result; this.#backend = backend; this.#runner = runner; this.#version = version;
    this.#binding = binding; this.#redactor = redactor; this.#task = task; this.#diagnostics = diagnostics;
  }
  get result(): CodexExecutionResult {
    return structuredClone({ stage: this.#stage, runner: this.#result, harness: this.#harness, authentication: this.#authentication,
      version: this.#version, diagnostics: this.#diagnostics });
  }
  toJSON(): CodexExecutionResult { return this.result; }
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
      this.#harness = new CodexAdapter().interpret({ task: this.#task, runner: this.#result, version: this.#version.actual!, stdout, redact: value => this.#redactor!.redact(value) });
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
