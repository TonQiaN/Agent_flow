import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { getuid, getgid } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { isIdentifier } from '@agentflow/domain';
import { TASK_PATHS, snapshotJson } from '@agentflow/engine';
import type { JsonValue, ExecutionIdentity } from '@agentflow/domain';
import type { ExecutionBackend, ExecutionResource, Observation, RawCapture, RunnerRequest, RunnerInputMaterializer, CapturedFile } from '@agentflow/engine';
import { docker, attach } from './process.js';
import type { AttachedProcess, DockerInteraction } from './process.js';
import { copyInput, captureFile, safeRelative } from './files.js';
import { nestedUserNamespacePolicy } from './sandbox-policy.js';
import { DockerEgress, egressOptions, prepareEgress } from './egress.js';
import type { DockerEgressOptions, PreparedEgress } from './egress.js';
import { stateEnvironment, credentialEnvironment } from '../execution/state-binding.js';
import type { PrivateStateBinding } from '../execution/state-binding.js';
import { resourceRecord, writeResourceMarker, verifyResourceDirectory } from './resource-record.js';
import type { DockerResourceRecord } from './resource-record.js';

export interface SystemConfigMount { readonly name: string; readonly target: string }
export function systemConfigMounts(value: readonly SystemConfigMount[] = []): readonly SystemConfigMount[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(m => !m || Object.keys(m).sort().join(',') !== 'name,target'
    || typeof m.name !== 'string' || !safeRelative(m.name) || m.name.length > 256
    || typeof m.target !== 'string' || m.target.length > 256 || !/^\/etc\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(m.target))
    || new Set(value.map(m => m.target)).size !== value.length
    || value.some(m => value.some(other => other.target.startsWith(`${m.target}/`)))) throw new Error('INVALID_SYSTEM_CONFIG_MOUNTS');
  return Object.freeze(value.map(m => Object.freeze({ ...m })));
}

export interface DockerOptions {
  readonly workspaceRoot: string;
  readonly image: string;
  readonly network?: 'none' | DockerEgressOptions;
  /** Trusted host choice. The task cannot supply arbitrary Docker security options. */
  readonly sandbox?: 'standard' | 'nested-userns-v1';
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly pidsLimit?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly logBytes?: number;
  /** Host-selected readonly mappings from this execution configFiles into system configuration directories. */
  readonly systemConfigMounts?: readonly SystemConfigMount[];
}
interface OwnedResource {
  directory: string;
  name: string;
  request?: RunnerRequest;
  imageId: string | null;
  attached?: AttachedProcess;
  removed: boolean;
  capture?: RawCapture;
  egress?: DockerEgress;
  checkpoint?: DockerResourceRecord;
  restored?: boolean;
}
interface Inspected { state: { Status: string; Running: boolean; ExitCode: number }; labels: Record<string, string>; image: string }

export class DockerBackend implements ExecutionBackend {
  #allocationStarted = false;
  #definition: JsonValue | undefined;
  #definitionPromise: Promise<JsonValue> | undefined;
  #pinnedImage: string | undefined;
  #egressPrepared: PreparedEgress | undefined;
  readonly #resources = new Map<string, OwnedResource>();
  readonly #released = new Set<string>();
  readonly #restoring = new Map<string, string>();
  readonly #options: Required<DockerOptions>;
  readonly #binding: PrivateStateBinding | undefined;
  readonly #interaction: DockerInteraction | undefined;
  readonly #input: RunnerInputMaterializer | undefined;
  readonly #stateEnv: Readonly<Record<string, string>>;

  constructor(options: DockerOptions, binding?: PrivateStateBinding, interaction?: DockerInteraction, input?: RunnerInputMaterializer) {
    const defaults = { network: 'none' as const, sandbox: 'standard' as const, cpus: 1, memoryMiB: 512, pidsLimit: 128,
      uid: getuid?.() ?? 1000, gid: getgid?.() ?? 1000, logBytes: 1024 * 1024, systemConfigMounts: [] as readonly SystemConfigMount[] };
    const config = { ...defaults, ...options };
    const allowed = ['workspaceRoot', 'image', ...Object.keys(defaults)];
    if (Object.keys(config).some(key => !allowed.includes(key)) || !isAbsolute(config.workspaceRoot)
      || /[,\0]/.test(config.workspaceRoot) || !/^[A-Za-z0-9][A-Za-z0-9./_:@-]*$/.test(config.image) || /\s/.test(config.image)
      || typeof config.network === 'string' && config.network !== 'none' || !['standard', 'nested-userns-v1'].includes(config.sandbox)
      || !Number.isFinite(config.cpus) || config.cpus < 0.1 || config.cpus > 64
      || !Number.isSafeInteger(config.memoryMiB) || config.memoryMiB < 16 || config.memoryMiB > 262144
      || !Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 1 || config.pidsLimit > 8192
      || !Number.isSafeInteger(config.uid) || config.uid < 1 || !Number.isSafeInteger(config.gid) || config.gid < 0
      || config.uid !== getuid?.() || config.gid !== getgid?.()
      || !Number.isSafeInteger(config.logBytes) || config.logBytes < 1 || config.logBytes > 16 * 1024 * 1024) throw new Error('INVALID_DOCKER_OPTIONS');
    this.#options = Object.freeze({ ...config, systemConfigMounts: systemConfigMounts(config.systemConfigMounts), network: config.network === 'none' ? 'none' : egressOptions(config.network) });
    if (binding && (typeof binding.prepare !== 'function' || typeof binding.beforeRelease !== 'function' || binding.secretEnvironment !== undefined && typeof binding.secretEnvironment !== 'function')) throw new Error('INVALID_STATE_BINDING');
    if (interaction && (typeof interaction.open !== 'function' || typeof interaction.output !== 'function')) throw new Error('INVALID_DOCKER_INTERACTION');
    if (input && (Object.keys(input).some(key => key !== 'materialize') || typeof input.materialize !== 'function')) throw new Error('INVALID_INPUT_MATERIALIZER');
    this.#input = input ? Object.freeze({ materialize: input.materialize.bind(input) }) : undefined;
    this.#interaction = interaction;
    this.#binding = binding;
    this.#stateEnv = stateEnvironment(binding?.environment ?? {});
  }

  #owned(resource: ExecutionResource): OwnedResource {
    const owned = this.#resources.get(resource.id);
    if (!owned) throw new Error('UNKNOWN_OWNED_RESOURCE');
    return owned;
  }

  /** Nonsecret configured options only; this does not make a private/network resource restorable. */
  configurationSnapshot(): JsonValue {
    return JSON.parse(JSON.stringify({ options: { ...this.#options, image: this.#pinnedImage ?? this.#options.image, network: this.#egressPrepared?.options ?? this.#options.network },
      paths: TASK_PATHS, sandboxPolicy: this.#options.sandbox === 'nested-userns-v1' ? nestedUserNamespacePolicy() : null }));
  }

  /** Only environment choices actually controlled by this backend are described. No resources are started. */
  async definition(): Promise<JsonValue> {
    if (this.#definition !== undefined) return structuredClone(this.#definition);
    if (this.#definitionPromise) return structuredClone(await this.#definitionPromise);
    if (this.#allocationStarted || this.#resources.size || this.#released.size) throw new Error('EXECUTION_DEFINITION_AFTER_ALLOCATION');
    if (this.#interaction || this.#binding && (typeof this.#binding.resourceDefinition !== 'function' || typeof this.#binding.restoreResource !== 'function'))
      throw new Error('EXECUTION_DEFINITION_UNAVAILABLE');
    const privateState = this.#binding ? snapshotJson(this.#binding.resourceDefinition!()) : undefined;
    this.#definitionPromise = (async () => {
      const [imageId, egress] = await Promise.all([docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]),
        this.#options.network === 'none' ? Promise.resolve(undefined) : prepareEgress(this.#options.network)]);
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
      this.#pinnedImage = imageId; this.#egressPrepared = egress;
      this.#definition = { schema: this.#binding ? 'agentflow-docker-execution/v3' : egress ? 'agentflow-docker-execution/v2' : 'agentflow-docker-execution/v1',
        ...this.configurationSnapshot() as Record<string, JsonValue>, ...(egress ? { egress: structuredClone(egress.definition) } : {}), ...(this.#binding ? { privateState: privateState! } : {}) };
      return structuredClone(this.#definition!);
    })();
    try { return structuredClone(await this.#definitionPromise); }
    finally { this.#definitionPromise = undefined; }
  }

  async allocate(): Promise<ExecutionResource> {
    this.#allocationStarted = true;
    if (this.#definitionPromise) await this.#definitionPromise;
    await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.#options.workspaceRoot, 'attempt-'));
    const id = `af-${randomUUID()}`;
    this.#resources.set(id, { directory, name: id, imageId: null, removed: false });
    return Object.freeze({ id });
  }

  async snapshotResource(resource: ExecutionResource, identity: ExecutionIdentity): Promise<JsonValue> {
    const owned = this.#owned(resource);
    if (!this.#definition || owned.request || owned.restored || owned.checkpoint) throw new Error('RESOURCE_SNAPSHOT_NOT_AVAILABLE');
    const record = resourceRecord(JSON.parse(JSON.stringify({ schema: 'agentflow-docker-resource/v1', resourceId: resource.id, directory: owned.directory, identity })), identity, this.#options.workspaceRoot);
    await writeResourceMarker(record); owned.checkpoint = record;
    return JSON.parse(JSON.stringify(record));
  }

  async restoreResource(value: JsonValue, identity: ExecutionIdentity, expected: ExecutionResource): Promise<ExecutionResource> {
    await this.definition();
    const record = resourceRecord(value, identity, this.#options.workspaceRoot);
    if (record.resourceId !== expected.id) throw new Error('RESOURCE_ID_MISMATCH');
    if (this.#resources.has(record.resourceId) || this.#released.has(record.resourceId) || this.#restoring.has(record.resourceId)
      || [...this.#restoring.values()].includes(record.directory)
      || [...this.#resources.values()].some(r => r.directory === record.directory)) throw new Error('RESOURCE_ALREADY_OWNED');
    this.#restoring.set(record.resourceId, record.directory);
    try {
      await verifyResourceDirectory(record);
      await this.#binding?.restoreResource?.({ id: record.resourceId });
      // No filesystem allocation and no container operation. Only later common query/stop observes it.
      this.#resources.set(record.resourceId, { directory: record.directory, name: record.resourceId, imageId: this.#pinnedImage!, removed: false, checkpoint: record, restored: true,
        ...(this.#options.network === 'none' ? {} : { egress: new DockerEgress(record.resourceId, record.directory, this.#options.network,
          { identity, prepared: this.#egressPrepared!, restored: true }) }) });
      return Object.freeze({ id: record.resourceId });
    } finally { this.#restoring.delete(record.resourceId); }
  }

  async prepare(resource: ExecutionResource, request: RunnerRequest): Promise<void> {
    const owned = this.#owned(resource);
    if (owned.restored) throw new Error('RESOURCE_EXECUTION_MISMATCH');
    if (owned.checkpoint) resourceRecord(JSON.parse(JSON.stringify(owned.checkpoint)), request.identity, this.#options.workspaceRoot);
    const invocation = request.invocation;
    if (Object.keys(request).some(key => !['identity', 'invocation', 'inputSource', 'timeoutMs'].includes(key))
      || Object.keys(invocation).some(key => !['argv', 'env', 'recordFiles', 'configFiles'].includes(key))) throw new Error('UNSUPPORTED_RUNNER_CONFIGURATION');
    const env = invocation.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.entries(env).some(([key, value]) => !['LANG', 'LC_ALL', 'TZ'].includes(key) || typeof value !== 'string' || value.includes('\0') || value.length > 1024)) throw new Error('UNSUPPORTED_ENVIRONMENT');
    const records = invocation.recordFiles ?? [];
    if (!Array.isArray(records) || records.length > 16 || new Set(records.map(item => item.id)).size !== records.length
      || records.some(item => !isIdentifier(item.id) || ['stdout', 'stderr'].includes(item.id) || typeof item.path !== 'string' || !safeRelative(item.path)
        || !Number.isSafeInteger(item.maxBytes) || item.maxBytes < 1 || item.maxBytes > 16 * 1024 * 1024) || records.reduce((total, item) => total + item.maxBytes, 0) > 16 * 1024 * 1024) throw new Error('INVALID_RECORD_CONFIGURATION');
    const configs = invocation.configFiles ?? [];
    if (!Array.isArray(configs) || configs.length > 16 || configs.some(file => !file || typeof file !== 'object'
      || Object.keys(file).sort().join(',') !== 'content,name' || typeof file.name !== 'string' || !safeRelative(file.name)
      || file.name.length > 256 || file.name.split('/').length > 8 || typeof file.content !== 'string'
      || Buffer.byteLength(file.content) > 64 * 1024)
      || new Set(configs.map(file => file.name)).size !== configs.length
      || configs.some(file => configs.some(other => other.name.startsWith(`${file.name}/`)))) throw new Error('INVALID_CONFIG_FILES');
    if (this.#options.systemConfigMounts.some(m => !configs.some(f => f.name === m.name))) throw new Error('MISSING_SYSTEM_CONFIG_SOURCE');
    if (this.#input && request.inputSource !== null) throw new Error('AMBIGUOUS_INPUT_SOURCE');
    owned.request = request;
    for (const name of [...Object.keys(TASK_PATHS), 'raw']) await mkdir(join(owned.directory, name), { mode: 0o700 });
    if (this.#input) {
      const staged = join(owned.directory, 'input-source');
      await this.#input.materialize(staged);
      await copyInput(staged, join(owned.directory, 'input'));
      await rm(staged, { recursive: true });
    } else if (request.inputSource !== null) await copyInput(request.inputSource, join(owned.directory, 'input'));
    for (const file of configs) {
      const path = join(owned.directory, 'config', file.name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, { flag: 'wx', mode: 0o600 });
    }
    if (this.#options.sandbox === 'nested-userns-v1') {
      await writeFile(join(owned.directory, 'sandbox-policy.json'), nestedUserNamespacePolicy(), { flag: 'wx', mode: 0o600 });
    }
    await this.#binding?.prepare(resource, join(owned.directory, 'state'));
  }

  async create(resource: ExecutionResource, request: RunnerRequest): Promise<void> {
    const owned = this.#owned(resource);
    if (owned.restored) throw new Error('RESOURCE_EXECUTION_MISMATCH');
    if (owned.checkpoint) resourceRecord(JSON.parse(JSON.stringify(owned.checkpoint)), request.identity, this.#options.workspaceRoot);
    const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#pinnedImage ?? this.#options.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
    owned.imageId = imageId;
    const options = this.#options;
    if (options.network !== 'none') {
      owned.egress = new DockerEgress(resource.id, owned.directory, options.network, { identity: request.identity, ...(this.#egressPrepared ? { prepared: this.#egressPrepared } : {}) });
      await owned.egress.setup(options.uid, options.gid);
    }
    const args = ['create', '--name', owned.name, '--label', `agentflow.resource=${resource.id}`,
      '--label', `agentflow.attempt=${request.identity.attemptId}`, '--label', `agentflow.run=${request.identity.runId}`,
      '--label', `agentflow.node-task=${request.identity.nodeTaskId}`, '--label', `agentflow.attempt-number=${request.identity.attemptNumber}`, '--restart', 'no', '--init',
      '--user', `${options.uid}:${options.gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', String(options.cpus), '--memory', `${options.memoryMiB}m`, '--memory-swap', `${options.memoryMiB}m`,
      '--pids-limit', String(options.pidsLimit), '--log-driver', 'none',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777', '--workdir', TASK_PATHS.work,
      '--env', `HOME=${TASK_PATHS.state}`, '--env', `AGENTFLOW_INPUT=${TASK_PATHS.input}`,
      '--env', `AGENTFLOW_OUTPUTS=${TASK_PATHS.outputs}`, '--env', `AGENTFLOW_STATE=${TASK_PATHS.state}`];
    if (this.#interaction) args.push('--interactive');
    args.push(...owned.egress?.arguments() ?? ['--network', 'none']);
    if (options.sandbox === 'nested-userns-v1') args.push('--ipc', 'private', '--security-opt', 'systempaths=unconfined',
      '--security-opt', `seccomp=${join(owned.directory, 'sandbox-policy.json')}`);
    for (const [key, path] of Object.entries(TASK_PATHS)) args.push('--mount', `type=bind,src=${join(owned.directory, key)},dst=${path}${key === 'config' ? ',readonly' : ''}`);
    for (const mount of options.systemConfigMounts) args.push('--mount', `type=bind,src=${join(owned.directory, 'config', mount.name)},dst=${mount.target},readonly`);
    for (const [key, value] of Object.entries(request.invocation.env ?? {})) args.push('--env', `${key}=${value}`);
    for (const [key, value] of Object.entries(this.#stateEnv)) args.push('--env', `${key}=${value}`);
    const secrets = credentialEnvironment(this.#binding?.secretEnvironment?.(resource) ?? {});
    if (Object.keys(secrets).some(key => Object.hasOwn(this.#stateEnv, key))) throw new Error('CONFLICTING_CREDENTIAL_ENVIRONMENT');
    for (const key of Object.keys(secrets)) args.push('--env', key);
    args.push('--entrypoint', request.invocation.argv[0]!, imageId, ...request.invocation.argv.slice(1));
    await docker(args, 15_000, secrets);
  }

  async #inspect(resource: ExecutionResource): Promise<Inspected | null> {
    const owned = this.#owned(resource);
    let raw: string;
    try {
      raw = await docker(['inspect', '--format', '{"state":{{json .State}},"labels":{{json .Config.Labels}},"image":{{json .Image}}}', owned.name]);
    } catch {
      // Failed inspection alone does not prove absence (the daemon may be unavailable).
      const found = await docker(['container', 'ls', '--all', '--filter', `name=^/${owned.name}$`, '--format', '{{.ID}}']);
      if (found === '') return null;
      throw new Error('INSPECT_FAILED');
    }
    const data = JSON.parse(raw) as Inspected;
    if (data.labels?.['agentflow.resource'] !== resource.id || !data.state || typeof data.state.Running !== 'boolean') throw new Error('RESOURCE_OWNERSHIP_MISMATCH');
    if (owned.checkpoint) {
      const i = owned.checkpoint.identity;
      if (data.labels['agentflow.run'] !== i.runId || data.labels['agentflow.node-task'] !== i.nodeTaskId
        || data.labels['agentflow.attempt'] !== i.attemptId || data.labels['agentflow.attempt-number'] !== String(i.attemptNumber)
        || data.image !== this.#pinnedImage) throw new Error('RESOURCE_EXECUTION_MISMATCH');
    }
    return data;
  }

  async start(resource: ExecutionResource): Promise<void> {
    const owned = this.#owned(resource);
    if (owned.restored) throw new Error('RESTORED_EXECUTION_CANNOT_START');
    const existing = await this.#inspect(resource);
    if (!existing || existing.state.Status !== 'created' || owned.attached) throw new Error('INVALID_START_STATE');
    await owned.egress?.assertRunning();
    owned.attached = attach(owned.name, join(owned.directory, 'raw', 'stdout.bin'), join(owned.directory, 'raw', 'stderr.bin'), this.#options.logBytes, this.#interaction);
  }

  async observe(resource: ExecutionResource): Promise<Observation> {
    const owned = this.#owned(resource);
    const existing = await this.#inspect(resource);
    if (owned.restored) await owned.egress?.verifyOwnership();
    if (!existing) return { state: 'absent' };
    if (owned.attached?.failed) throw new Error('ATTACH_INTERACTION_FAILED');
    if (existing.state.Running) {
      if (!owned.restored) await owned.egress?.assertRunning();
      if (owned.attached?.settled) { owned.attached.failed = true; throw new Error('ATTACH_ENDED_EARLY'); }
      return { state: 'running' };
    }
    if (existing.state.Status === 'created') {
      if (owned.attached?.settled) throw new Error('START_FAILED');
      return { state: 'created' };
    }
    if (existing.state.Status !== 'exited' || !Number.isSafeInteger(existing.state.ExitCode)) throw new Error('UNKNOWN_CONTAINER_STATE');
    return { state: 'exited', exitCode: existing.state.ExitCode };
  }

  async stop(resource: ExecutionResource): Promise<{ confirmed: boolean }> {
    const owned = this.#owned(resource);
    try {
      let existing = await this.#inspect(resource);
      // Never turn an in-flight Docker start into a false stopped fact by killing only its CLI.
      if (owned.attached && !owned.attached.settled && existing?.state.Status === 'created') {
        for (let poll = 0; poll < 20 && !owned.attached.settled && existing?.state.Status === 'created'; poll++) {
          await delay(50);
          existing = await this.#inspect(resource);
        }
        if (!owned.attached.settled && existing?.state.Status === 'created') return { confirmed: false };
      }
      if (existing?.state.Running) {
        try { await docker(['stop', '--time', '1', owned.name], 5000); } catch { /* Reinspect and escalate below. */ }
        existing = await this.#inspect(resource);
        if (existing?.state.Running) {
          await docker(['kill', owned.name], 5000);
          existing = await this.#inspect(resource);
        }
      }
      return { confirmed: !existing || !existing.state.Running && ['created', 'exited', 'dead'].includes(existing.state.Status) };
    } catch { return { confirmed: false }; }
  }

  async #settleAttach(owned: OwnedResource): Promise<void> {
    const process = owned.attached;
    if (!process || process.settled) return;
    await Promise.race([process.done, delay(1000)]);
    if (!process.settled) {
      process.failed = true;
      process.child.kill('SIGKILL');
      await process.done;
    }
  }

  async capture(resource: ExecutionResource): Promise<RawCapture> {
    const owned = this.#owned(resource);
    if (owned.capture) return owned.capture;
    await this.#settleAttach(owned);
    if (owned.attached) {
      const observed = await this.#inspect(resource);
      if (!observed || observed.state.Running || owned.attached.exitCode !== observed.state.ExitCode) owned.attached.failed = true;
    }
    const unstarted = (name: string): CapturedFile => ({ path: join(owned.directory, 'raw', name), bytes: 0, truncated: false, complete: false, error: 'NOT_STARTED' });
    const files: Record<string, CapturedFile> = {};
    for (const record of owned.request?.invocation.recordFiles ?? []) {
      files[record.id] = await captureFile(join(owned.directory, 'state'), record.path, join(owned.directory, 'raw', `${record.id}.bin`), record.maxBytes);
    }
    owned.capture = { stdout: owned.attached?.stdout ?? unstarted('stdout.bin'), stderr: owned.attached?.stderr ?? unstarted('stderr.bin'),
      files, outputsPath: join(owned.directory, 'outputs'), imageId: owned.imageId,
      ...(owned.egress ? { network: owned.egress.evidence() } : {}) };
    return owned.capture;
  }

  async remove(resource: ExecutionResource): Promise<void> {
    const owned = this.#owned(resource);
    const existing = await this.#inspect(resource);
    if (existing?.state.Running) throw new Error('REMOVE_RUNNING_CONTAINER');
    if (existing) await docker(['rm', owned.name]);
    if (await this.#inspect(resource)) throw new Error('CONTAINER_NOT_REMOVED');
    await owned.egress?.remove();
    owned.removed = true;
  }

  async release(resource: ExecutionResource): Promise<void> {
    if (this.#released.has(resource.id)) return;
    const owned = this.#owned(resource);
    if (!owned.removed) throw new Error('RESOURCE_STILL_OWNED_BY_EXECUTION');
    if (owned.checkpoint) await verifyResourceDirectory(owned.checkpoint);
    await this.#binding?.beforeRelease(resource);
    await rm(owned.directory, { recursive: true, force: true });
    this.#resources.delete(resource.id);
    this.#released.add(resource.id);
  }
}
