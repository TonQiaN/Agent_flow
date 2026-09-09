import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isExecutionIdentity } from '@agentflow/domain';
import type { ExecutionIdentity } from '@agentflow/domain';
import { Runner } from '@agentflow/engine';
import type { Cancellation, ExecutionResource, RunnerResult } from '@agentflow/engine';
import { DockerBackend } from '../docker/backend.js';
import { docker } from '../docker/process.js';
import type { DockerInteraction } from '../docker/process.js';
import { readCapturedBytes } from '../execution/capture-reader.js';
import type { PrivateStateBinding } from '../execution/state-binding.js';
import { systemClock } from '../system-clock.js';
import { readPrivate } from './file-store.js';
import type { SubscriptionLoginDriver } from './subscription-login.js';

export interface DockerLoginOptions { readonly workspaceRoot: string; readonly image: string; readonly proxyImage: string; readonly timeoutMs: number }
/** Internal provider recipe. Applications select a concrete provider driver, never a JSON recipe. */
export interface LoginRecipe {
  readonly version: string; readonly versionCommand: readonly string[]; readonly argv: readonly string[];
  readonly hosts: readonly string[]; readonly directory: string; readonly filename: string;
  readonly environment: Readonly<Record<string, string>>;
  parseVersion(stdout: string): string | null;
  validateCredential(content: string): boolean;
}

class LoginState implements PrivateStateBinding {
  readonly environment: Readonly<Record<string, string>>;
  #directory: string | null = null; #resource: string | null = null;
  constructor(private readonly recipe: LoginRecipe) { this.environment = recipe.environment; }
  async prepare(resource: ExecutionResource, root: string): Promise<void> {
    if (this.#resource) throw new Error('LOGIN_STATE_ALREADY_USED');
    this.#resource = resource.id; this.#directory = join(root, this.recipe.directory);
    await mkdir(this.#directory, { mode: 0o700 });
  }
  async read(resource: ExecutionResource): Promise<string> {
    if (!this.#directory || this.#resource !== resource.id) throw new Error('LOGIN_STATE_MISMATCH');
    const parent = await lstat(this.#directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error('UNSAFE_LOGIN_DIRECTORY');
    return readPrivate(join(this.#directory, this.recipe.filename), 1024 * 1024);
  }
  async beforeRelease(resource: ExecutionResource): Promise<void> {
    if (this.#resource !== null && this.#resource !== resource.id) throw new Error('LOGIN_STATE_MISMATCH');
  }
}

/** One login, two sequential owned executions: offline version probe, then private interactive login. */
export class DockerSubscriptionLoginDriver implements SubscriptionLoginDriver {
  readonly #options: DockerLoginOptions; readonly #interaction: DockerInteraction; readonly #recipe: LoginRecipe;
  #backend: DockerBackend | null = null; #runner: Runner | null = null; #result: RunnerResult | null = null;
  #state: LoginState | null = null; #empty: string | null = null; #started = false; #login = false; #released = false;
  #imageId: string | null = null;
  constructor(options: DockerLoginOptions, interaction: DockerInteraction, recipe: LoginRecipe) {
    if (!options || Object.keys(options).sort().join(',') !== 'image,proxyImage,timeoutMs,workspaceRoot'
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30 * 60_000) throw new Error('INVALID_LOGIN_OPTIONS');
    new DockerBackend({ image: options.image, workspaceRoot: options.workspaceRoot,
      network: { kind: 'connect-proxy', proxyImage: options.proxyImage, allowedHosts: recipe.hosts } }, undefined, interaction);
    this.#options = Object.freeze({ ...options }); this.#interaction = interaction; this.#recipe = recipe;
  }
  toJSON(): { started: boolean; released: boolean } { return { started: this.#started, released: this.#released }; }
  #view(): RunnerResult { if (!this.#result) throw new Error('LOGIN_NOT_STARTED'); return structuredClone(this.#result); }
  #match(proof: RunnerResult | null): void {
    if (proof && (!this.#result || Object.entries(this.#result.identity).some(([key, value]) => proof.identity[key as keyof ExecutionIdentity] !== value) || proof.resource?.id !== this.#result.resource?.id)) throw new Error('LOGIN_EXECUTION_MISMATCH');
  }
  async run(identity: ExecutionIdentity, cancellation: Cancellation): Promise<RunnerResult> {
    if (this.#started || !isExecutionIdentity(identity)) throw new Error('LOGIN_ALREADY_STARTED_OR_INVALID');
    this.#started = true;
    identity = Object.freeze({ ...identity });
    const now = Date.now();
    this.#result = { identity: { ...identity }, resource: null, phase: 'failed', exitCode: null, stop: 'not_started', cleanup: 'not_created', capture: null,
      diagnostics: ['LOGIN_NOT_STARTED'], startedAt: now, finishedAt: now };
    try {
      if (cancellation.requested()) { this.#result = { ...this.#result, phase: 'cancelled' }; return this.#view(); }
      this.#imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]);
      if (!/^sha256:[a-f0-9]{64}$/.test(this.#imageId)) throw new Error('INVALID_IMAGE_ID');
      await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
      this.#empty = await mkdtemp(join(this.#options.workspaceRoot, 'login-input-'));
      this.#backend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: this.#imageId });
      this.#runner = new Runner(this.#backend, systemClock);
      this.#result = await this.#runner.run({ identity, inputSource: this.#empty, timeoutMs: 10_000, invocation: { argv: this.#recipe.versionCommand } }, cancellation);
      const probe = this.#result;
      let version: string | null = null;
      if (probe.phase === 'exited' && probe.exitCode === 0 && probe.stop === 'confirmed' && probe.cleanup === 'removed' && probe.capture?.imageId === this.#imageId
        && [probe.capture.stdout, probe.capture.stderr].every(f => f.complete && !f.truncated && !f.error)) {
        version = this.#recipe.parseVersion(new TextDecoder('utf-8', { fatal: true }).decode(await readCapturedBytes(probe.capture.stdout, 1024 * 1024)));
      }
      // The version probe can never be returned as a successful login, including release/read exceptions.
      this.#result = { ...probe, phase: 'failed', diagnostics: [...probe.diagnostics, 'LOGIN_VERSION_NOT_ACCEPTED'] };
      if (version !== this.#recipe.version) return this.#view();
      if (probe.resource) await this.#runner.release(probe.resource);
      this.#result = { ...this.#result, resource: null, stop: 'not_started', cleanup: 'not_created', capture: null };
      this.#backend = null; this.#runner = null;
      if (cancellation.requested()) { this.#result = { ...this.#result, phase: 'cancelled' }; return this.#view(); }
      this.#state = new LoginState(this.#recipe);
      this.#backend = new DockerBackend({ workspaceRoot: this.#options.workspaceRoot, image: this.#imageId, memoryMiB: 1024,
        network: { kind: 'connect-proxy', proxyImage: this.#options.proxyImage, allowedHosts: this.#recipe.hosts } }, this.#state, this.#interaction);
      this.#runner = new Runner(this.#backend, systemClock); this.#login = true;
      this.#result = await this.#runner.run({ identity, inputSource: this.#empty, timeoutMs: this.#options.timeoutMs, invocation: { argv: this.#recipe.argv } }, cancellation);
      // EOF, output loss and interaction errors are not a successful authentication transport.
      if (!this.#completeCapture()) this.#result = { ...this.#result, phase: 'failed', diagnostics: [...this.#result.diagnostics, 'LOGIN_CAPTURE_NOT_CONFIRMED'] };
      return this.#view();
    } catch {
      this.#result = { ...this.#result, phase: 'failed', diagnostics: [...this.#result.diagnostics, 'LOGIN_DRIVER_FAILED'] };
      return this.#view();
    }
  }
  #completeCapture(): boolean {
    const capture = this.#result?.capture;
    return !!capture && capture.imageId === this.#imageId && [capture.stdout, capture.stderr].every(f => f.complete && !f.truncated && !f.error);
  }
  async readCredential(proof: RunnerResult): Promise<string> {
    this.#match(proof); const result = this.#result;
    if (this.#released || !this.#login || !this.#state || !result?.resource || result.phase !== 'exited' || result.exitCode !== 0
      || result.stop !== 'confirmed' || result.cleanup !== 'removed' || !this.#completeCapture()) throw new Error('LOGIN_NOT_SUCCESSFUL');
    // Validate the private captures against their recorded sizes/inodes before accepting the file.
    await readCapturedBytes(result.capture!.stdout, 1024 * 1024); await readCapturedBytes(result.capture!.stderr, 1024 * 1024);
    const content = await this.#state.read(result.resource);
    if (!this.#recipe.validateCredential(content)) throw new Error('LOGIN_CREDENTIAL_NOT_USABLE');
    return content;
  }
  async recover(previous: RunnerResult | null): Promise<RunnerResult> {
    this.#match(previous);
    if (!this.#result || this.#released) throw new Error('LOGIN_NOT_RECOVERABLE');
    const resource = this.#result.resource;
    if (resource && this.#result.cleanup !== 'removed') {
      if (!this.#backend || !(await this.#backend.stop(resource)).confirmed) throw new Error('LOGIN_STOP_UNCONFIRMED');
      await this.#backend.remove(resource);
      this.#result = { ...this.#result, stop: 'confirmed', cleanup: 'removed' };
    }
    return this.#view();
  }
  async release(proof: RunnerResult): Promise<void> {
    this.#match(proof);
    if (this.#released) return;
    if (!this.#result || (this.#result.resource ? this.#result.stop !== 'confirmed' || this.#result.cleanup !== 'removed'
      : this.#result.stop !== 'not_started' || this.#result.cleanup !== 'not_created')) throw new Error('LOGIN_CLEANUP_REQUIRED');
    if (this.#result.resource) await this.#runner!.release(this.#result.resource);
    if (this.#empty) await rm(this.#empty, { recursive: true, force: true });
    this.#released = true;
  }
}
