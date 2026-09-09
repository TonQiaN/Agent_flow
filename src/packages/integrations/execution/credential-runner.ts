import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner, snapshotJson, canonicalJson } from '@agentflow/engine';
import type { Cancellation, CredentialIdentity, CredentialStore, HarnessAdapter, HarnessPlan, HarnessResult, HarnessTask, RunnerResult, Invocation, RunnerResourceCheckpoint, RunnerResourceSink, RunnerLaunchState, RestoredRunnerResource } from '@agentflow/engine';
import type { JsonValue } from '@agentflow/domain';
import type { DockerOptions, SystemConfigMount } from '../docker/backend.js';
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
  { readonly binding: 'exclusive' | 'snapshot'; readonly stateFile: string; readonly secretEnvironment?: never }
  | { readonly binding: 'environment'; readonly secretEnvironmentKeys: readonly string[]; readonly secretEnvironment: (content: string) => Readonly<Record<string, string>>; readonly stateFile?: never }
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

/** Separate pre-authentication resource. This is not the later Agent execution checkpoint. */
export interface CredentialVersionResourceCheckpoint {
  readonly schema: 'agentflow-credential-version-resource/v1';
  readonly definition: JsonValue;
  readonly runner: RunnerResourceCheckpoint;
}
export interface CredentialVersionResourceSink {
  save(checkpoint: CredentialVersionResourceCheckpoint): Promise<void>;
  launch(state: Exclude<RunnerLaunchState, 'allocated'>): Promise<void>;
  /** Called only after successful version verification and confirmed resource release; rejection blocks credentials. */
  complete(): Promise<void>;
}

export interface CredentialRunPersistence {
  readonly version: CredentialVersionResourceSink;
  /** Only transports with actual resource restoration support can enable this phase. */
  readonly execution?: RunnerResourceSink;
}

/** Environment composition. Engine Runner and the pure Adapter have no provider-auth branches. */
export class CredentialHarnessRunner<P extends CredentialIdentity> {
  readonly #store: CredentialStore;
  readonly #options: { workspaceRoot: string; image: string; proxyImage: string };
  readonly #recipe: CredentialRecipe<P>;
  readonly #executionDefinitions = new Map<string, Promise<JsonValue>>();
  #started = false;
  #images: { image: string; proxyImage: string } | undefined;
  #imagesPending: Promise<{ image: string; proxyImage: string }> | undefined;
  constructor(store: CredentialStore, options: { workspaceRoot: string; image: string; proxyImage: string }, recipe: CredentialRecipe<P>) {
    if (!options || Object.keys(options).sort().join(',') !== 'image,proxyImage,workspaceRoot') throw new Error('INVALID_SUBSCRIPTION_RUNNER');
    this.#recipe = Object.freeze({ ...recipe, hosts: Object.freeze([...recipe.hosts]), versionCommand: Object.freeze([...recipe.versionCommand]),
      ...(recipe.systemConfigMounts ? { systemConfigMounts: Object.freeze(recipe.systemConfigMounts.map(m => Object.freeze({ ...m }))) } : {}) });
    if (recipe.binding === 'environment') this.#recipe = Object.freeze({ ...this.#recipe, secretEnvironmentKeys: Object.freeze([...recipe.secretEnvironmentKeys]) }) as CredentialRecipe<P>;
    this.#store = store; this.#options = Object.freeze({ ...options });
    // Use exactly the same validated environment options for descriptions and execution.
    new DockerBackend(this.#backendOptions(options.image, options.proxyImage));
  }
  #backendOptions(image: string, proxyImage: string): DockerOptions {
    return { workspaceRoot: this.#options.workspaceRoot, image, sandbox: 'nested-userns-v1',
      ...(this.#recipe.memoryMiB ? { memoryMiB: this.#recipe.memoryMiB } : {}),
      ...(this.#recipe.systemConfigMounts ? { systemConfigMounts: this.#recipe.systemConfigMounts } : {}),
      network: { kind: 'connect-proxy', proxyImage, allowedHosts: this.#recipe.hosts } };
  }
  async #freezeImages(): Promise<{ image: string; proxyImage: string }> {
    if (this.#images) return this.#images;
    if (this.#imagesPending) return this.#imagesPending;
    if (this.#started) throw new Error('EXECUTION_DEFINITION_AFTER_START');
    this.#imagesPending = (async () => {
      const [image, proxyImage] = await Promise.all([this.#options.image, this.#options.proxyImage]
        .map(name => docker(['image', 'inspect', '--format', '{{.Id}}', name])));
      if (!image || !proxyImage || ![image, proxyImage].every(id => /^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('INVALID_IMAGE_ID');
      this.#images = Object.freeze({ image, proxyImage }); return this.#images;
    })();
    try { return await this.#imagesPending; } finally { this.#imagesPending = undefined; }
  }
  #credential(profile: P): CredentialIdentity { return { credentialRef: profile.credentialRef, service: profile.service, method: profile.method }; }
  #recoveryBinding(profile: P) {
    if (this.#recipe.binding !== 'environment') throw new Error('CREDENTIAL_RESOURCE_RESTORE_UNAVAILABLE');
    return EnvironmentExecutionCredentialBinding.recoveryBinding(this.#credential(profile), this.#recipe.secretEnvironmentKeys);
  }
  /** Actual immutable environment transport; no source store access. */
  async executionResourceDefinition(rawProfile: P): Promise<JsonValue> {
    const profile = this.#recipe.profile(structuredClone(rawProfile)), binding = this.#recoveryBinding(profile);
    const key = canonicalJson(snapshotJson(this.#credential(profile)));
    let pending = this.#executionDefinitions.get(key);
    if (!pending) {
      pending = (async () => {
        const images = await this.#freezeImages();
        return new DockerBackend(this.#backendOptions(images.image, images.proxyImage), binding).definition();
      })();
      this.#executionDefinitions.set(key, pending);
      pending.catch(() => { if (this.#executionDefinitions.get(key) === pending) this.#executionDefinitions.delete(key); });
    }
    return structuredClone(await pending);
  }
  async restoreExecutionResource(value: RunnerResourceCheckpoint, rawProfile: P): Promise<RestoredRunnerResource> {
    const profile = this.#recipe.profile(structuredClone(rawProfile)), record = structuredClone(value);
    if (canonicalJson(record.execution) !== canonicalJson(await this.executionResourceDefinition(profile))) throw new Error('CREDENTIAL_RESOURCE_DEFINITION_MISMATCH');
    const images = this.#images!;
    return new Runner(new DockerBackend(this.#backendOptions(images.image, images.proxyImage), this.#recoveryBinding(profile)), systemClock).restore(record);
  }
  #probeBackend(image: string): DockerBackend { return new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image }); }
  async versionProbeDefinition(): Promise<JsonValue> {
    const { image } = await this.#freezeImages();
    return snapshotJson({ schema: 'agentflow-credential-version/v1', expected: this.#recipe.version,
      argv: this.#recipe.versionCommand, timeoutMs: 10_000, backend: await this.#probeBackend(image).definition() });
  }
  /** Trusted saved facts; the caller must fence recovery. Never probes, acquires credentials or starts Agent execution. */
  async restoreVersionResource(value: CredentialVersionResourceCheckpoint): Promise<RestoredRunnerResource> {
    const record = snapshotJson(value) as unknown as CredentialVersionResourceCheckpoint;
    if (!record || Object.keys(record).sort().join(',') !== 'definition,runner,schema' || record.schema !== 'agentflow-credential-version-resource/v1'
      || canonicalJson(record.definition) !== canonicalJson(await this.versionProbeDefinition())) throw new Error('VERSION_RESOURCE_DEFINITION_MISMATCH');
    return new Runner(this.#probeBackend(this.#images!.image), systemClock).restore(record.runner);
  }
  /** Inspect actual host choices without opening the credential store or starting a version probe. */
  async definitionSnapshot(task: HarnessTask, rawProfile: P, timeoutMs: number): Promise<JsonValue> {
    const captured = structuredClone(task), profile = this.#recipe.profile(structuredClone(rawProfile));
    const { identity: _identity, ...plan } = this.#recipe.adapter().plan(captured);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const invocation = this.#recipe.invocation({ ...plan, identity: captured.identity });
    const images = await this.#freezeImages();
    return snapshotJson({ schema: 'agentflow-credential-execution/v2', versionProbe: await this.versionProbeDefinition(),
      task: { prompt: captured.prompt, config: captured.config, outcomes: captured.outcomes ?? null }, plan, invocation,
      profile, timeoutMs, version: this.#recipe.version, versionCommand: this.#recipe.versionCommand,
      authentication: { binding: this.#recipe.binding, stateFile: this.#recipe.stateFile ?? null,
        environment: this.#recipe.stateEnvironment({ ...plan, identity: captured.identity }) },
      environment: this.#recipe.binding === 'environment' ? await this.executionResourceDefinition(profile)
        : new DockerBackend(this.#backendOptions(images.image, images.proxyImage)).configurationSnapshot() });
  }

  async run(request: CredentialRunRequest<P>, cancellation: Cancellation = { requested: () => false }, persistence?: CredentialRunPersistence): Promise<CredentialExecution> {
    let task: HarnessTask;
    try { task = structuredClone(request.task); } catch { throw new Error('INVALID_HARNESS_TASK'); }
    const adapter = this.#recipe.adapter(); const plan = adapter.plan(task);
    const invocation = this.#recipe.invocation(plan);
    const profile = this.#recipe.profile(request.profile);
    const inputSource = request.inputSource; const timeoutMs = request.timeoutMs;
    if (Object.keys(request).sort().join(',') !== 'inputSource,profile,task,timeoutMs' || typeof inputSource !== 'string'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const probePersistence = persistence?.version;
    if (persistence && (!probePersistence || Object.keys(persistence).some(key => !['version', 'execution'].includes(key)))) throw new Error('INVALID_CREDENTIAL_RESOURCE_SINK');
    if (persistence?.execution && (typeof persistence.execution.save !== 'function' || persistence.execution.launch !== undefined && typeof persistence.execution.launch !== 'function')) throw new Error('INVALID_CREDENTIAL_RESOURCE_SINK');
    if (probePersistence && (typeof probePersistence.save !== 'function' || typeof probePersistence.launch !== 'function' || typeof probePersistence.complete !== 'function'))
      throw new Error('INVALID_VERSION_RESOURCE_SINK');
    if (!persistence) this.#started = true; // Reserve before the ordinary run first yields, including an absent cached environment.
    const probeDefinition = probePersistence ? await this.versionProbeDefinition() : undefined;
    const probeSink: RunnerResourceSink | undefined = probePersistence ? {
      save: checkpoint => probePersistence.save({ schema: 'agentflow-credential-version-resource/v1', definition: structuredClone(probeDefinition!), runner: checkpoint }),
      launch: state => probePersistence.launch(state),
    } : undefined;
    const expectedEnvironment = persistence?.execution ? await this.executionResourceDefinition(profile) : await this.#executionDefinitions.get(canonicalJson(snapshotJson(this.#credential(profile))));
    this.#started = true;
    if (this.#imagesPending) await this.#imagesPending;
    const imageId = this.#images?.image ?? await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
    const probeBackend = this.#probeBackend(imageId);
    const probeRunner = new Runner(probeBackend, systemClock);
    await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
    const empty = await mkdtemp(join(this.#options.workspaceRoot, 'version-input-'));
    let probe: RunnerResult;
    try { probe = await probeRunner.run({ identity: task.identity, inputSource: empty, timeoutMs: 10_000, invocation: { argv: this.#recipe.versionCommand } }, cancellation, probeSink); }
    finally { await rm(empty, { recursive: true, force: true }); }
    let actual: string | null = null;
    if (probe.phase === 'exited' && probe.exitCode === 0 && probe.stop === 'confirmed' && probe.cleanup === 'removed'
      && probe.capture?.imageId === imageId && [probe.capture.stdout, probe.capture.stderr].every(file => file.complete && !file.truncated && !file.error)) {
      try { actual = this.#recipe.parseVersion(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readCapturedBytes(probe.capture.stdout, 16 * 1024 * 1024))); } catch { /* Static mismatch below. */ }
    }
    const version = Object.freeze({ expected: this.#recipe.version, actual, imageId });
    if (actual !== this.#recipe.version) return new CredentialExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['HARNESS_VERSION_NOT_VERIFIED']);
    try { if (probe.resource) await probeRunner.release(probe.resource); }
    catch { return new CredentialExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['VERSION_WORKSPACE_RELEASE_FAILED']); }

    try { await probePersistence?.complete(); }
    catch { return new CredentialExecution('version', probe, probeBackend, probeRunner, version, null, null, null, ['VERSION_COMPLETION_NOT_PERSISTED']); }

    const redactor = this.#recipe.redactor();
    const credential = { credentialRef: profile.credentialRef, service: profile.service, method: profile.method };
    const binding = this.#recipe.binding === 'environment'
      ? await EnvironmentExecutionCredentialBinding.acquire(this.#store, { identity: task.identity, credential }, this.#recipe.secretEnvironment, 0, content => redactor.remember(content))
      : await (this.#recipe.binding === 'snapshot' ? FileExecutionCredentialBinding.acquireSnapshot : FileExecutionCredentialBinding.acquire).call(FileExecutionCredentialBinding,
        this.#store, { identity: task.identity, credential, stateFile: this.#recipe.stateFile, environment: this.#recipe.stateEnvironment(plan) }, 0, content => redactor.remember(content));
    let backend: DockerBackend; let runner: Runner; let result: RunnerResult;
    try {
      backend = new DockerBackend(this.#backendOptions(imageId, this.#images?.proxyImage ?? this.#options.proxyImage), binding);
      if (expectedEnvironment && canonicalJson(await backend.definition()) !== canonicalJson(expectedEnvironment)) throw new Error('CREDENTIAL_RESOURCE_DEFINITION_MISMATCH');
      runner = new Runner(backend, systemClock);
      result = await runner.run({ identity: task.identity, inputSource, timeoutMs, invocation }, cancellation, persistence?.execution);
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
