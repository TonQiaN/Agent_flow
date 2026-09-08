import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { getuid, getgid } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { isIdentifier } from '@agentflow/domain';
import { TASK_PATHS } from '@agentflow/engine';
import type { ExecutionBackend, ExecutionResource, Observation, RawCapture, RunnerRequest, CapturedFile } from '@agentflow/engine';
import { docker, attach } from './process.js';
import type { AttachedProcess } from './process.js';
import { copyInput, captureFile, safeRelative } from './files.js';
import { nestedUserNamespacePolicy } from './sandbox-policy.js';

export interface DockerOptions {
  readonly workspaceRoot: string;
  readonly image: string;
  readonly network?: 'none';
  /** Trusted host choice. The task cannot supply arbitrary Docker security options. */
  readonly sandbox?: 'standard' | 'nested-userns-v1';
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly pidsLimit?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly logBytes?: number;
}
interface OwnedResource {
  directory: string;
  name: string;
  request?: RunnerRequest;
  imageId: string | null;
  attached?: AttachedProcess;
  removed: boolean;
  capture?: RawCapture;
}
interface Inspected { state: { Status: string; Running: boolean; ExitCode: number }; owner: string }

export class DockerBackend implements ExecutionBackend {
  readonly #resources = new Map<string, OwnedResource>();
  readonly #released = new Set<string>();
  readonly #options: Required<DockerOptions>;

  constructor(options: DockerOptions) {
    const defaults = { network: 'none' as const, sandbox: 'standard' as const, cpus: 1, memoryMiB: 512, pidsLimit: 128,
      uid: getuid?.() ?? 1000, gid: getgid?.() ?? 1000, logBytes: 1024 * 1024 };
    const config = { ...defaults, ...options };
    const allowed = ['workspaceRoot', 'image', ...Object.keys(defaults)];
    if (Object.keys(config).some(key => !allowed.includes(key)) || !isAbsolute(config.workspaceRoot)
      || /[,\0]/.test(config.workspaceRoot) || !/^[A-Za-z0-9][A-Za-z0-9./_:@-]*$/.test(config.image) || /\s/.test(config.image)
      || config.network !== 'none' || !['standard', 'nested-userns-v1'].includes(config.sandbox)
      || !Number.isFinite(config.cpus) || config.cpus < 0.1 || config.cpus > 64
      || !Number.isSafeInteger(config.memoryMiB) || config.memoryMiB < 16 || config.memoryMiB > 262144
      || !Number.isSafeInteger(config.pidsLimit) || config.pidsLimit < 1 || config.pidsLimit > 8192
      || !Number.isSafeInteger(config.uid) || config.uid < 1 || !Number.isSafeInteger(config.gid) || config.gid < 0
      || config.uid !== getuid?.() || config.gid !== getgid?.()
      || !Number.isSafeInteger(config.logBytes) || config.logBytes < 1 || config.logBytes > 16 * 1024 * 1024) throw new Error('INVALID_DOCKER_OPTIONS');
    this.#options = Object.freeze(config);
  }

  #owned(resource: ExecutionResource): OwnedResource {
    const owned = this.#resources.get(resource.id);
    if (!owned) throw new Error('UNKNOWN_OWNED_RESOURCE');
    return owned;
  }

  async allocate(): Promise<ExecutionResource> {
    await mkdir(this.#options.workspaceRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.#options.workspaceRoot, 'attempt-'));
    const id = `af-${randomUUID()}`;
    this.#resources.set(id, { directory, name: id, imageId: null, removed: false });
    return Object.freeze({ id });
  }

  async prepare(resource: ExecutionResource, request: RunnerRequest): Promise<void> {
    const owned = this.#owned(resource);
    const invocation = request.invocation;
    if (Object.keys(request).some(key => !['identity', 'invocation', 'inputSource', 'timeoutMs'].includes(key))
      || Object.keys(invocation).some(key => !['argv', 'env', 'recordFiles', 'configFiles'].includes(key))) throw new Error('UNSUPPORTED_RUNNER_CONFIGURATION');
    const env = invocation.env ?? {};
    if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.entries(env).some(([key, value]) => !['LANG', 'LC_ALL', 'TZ'].includes(key) || typeof value !== 'string' || value.includes('\0') || value.length > 1024)) throw new Error('UNSUPPORTED_ENVIRONMENT');
    const records = invocation.recordFiles ?? [];
    if (!Array.isArray(records) || records.length > 16 || new Set(records.map(item => item.id)).size !== records.length
      || records.some(item => !isIdentifier(item.id) || ['stdout', 'stderr'].includes(item.id) || typeof item.path !== 'string' || !safeRelative(item.path)
        || !Number.isSafeInteger(item.maxBytes) || item.maxBytes < 1 || item.maxBytes > 1024 * 1024)) throw new Error('INVALID_RECORD_CONFIGURATION');
    const configs = invocation.configFiles ?? [];
    if (!Array.isArray(configs) || configs.length > 16 || configs.some(file => !file || typeof file !== 'object'
      || Object.keys(file).sort().join(',') !== 'content,name' || typeof file.name !== 'string' || !safeRelative(file.name)
      || file.name.length > 256 || file.name.split('/').length > 8 || typeof file.content !== 'string'
      || Buffer.byteLength(file.content) > 64 * 1024)
      || new Set(configs.map(file => file.name)).size !== configs.length
      || configs.some(file => configs.some(other => other.name.startsWith(`${file.name}/`)))) throw new Error('INVALID_CONFIG_FILES');
    owned.request = request;
    for (const name of [...Object.keys(TASK_PATHS), 'raw']) await mkdir(join(owned.directory, name), { mode: 0o700 });
    await copyInput(request.inputSource, join(owned.directory, 'input'));
    for (const file of configs) {
      const path = join(owned.directory, 'config', file.name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, { flag: 'wx', mode: 0o600 });
    }
    if (this.#options.sandbox === 'nested-userns-v1') {
      await writeFile(join(owned.directory, 'sandbox-policy.json'), nestedUserNamespacePolicy(), { flag: 'wx', mode: 0o600 });
    }
  }

  async create(resource: ExecutionResource, request: RunnerRequest): Promise<void> {
    const owned = this.#owned(resource);
    const imageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('INVALID_IMAGE_ID');
    owned.imageId = imageId;
    const options = this.#options;
    const args = ['create', '--name', owned.name, '--label', `agentflow.resource=${resource.id}`,
      '--label', `agentflow.attempt=${request.identity.attemptId}`, '--restart', 'no', '--init',
      '--user', `${options.uid}:${options.gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', String(options.cpus), '--memory', `${options.memoryMiB}m`, '--memory-swap', `${options.memoryMiB}m`,
      '--pids-limit', String(options.pidsLimit), '--network', 'none', '--log-driver', 'none',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777', '--workdir', TASK_PATHS.work,
      '--env', `HOME=${TASK_PATHS.state}`, '--env', `AGENTFLOW_INPUT=${TASK_PATHS.input}`,
      '--env', `AGENTFLOW_OUTPUTS=${TASK_PATHS.outputs}`, '--env', `AGENTFLOW_STATE=${TASK_PATHS.state}`];
    if (options.sandbox === 'nested-userns-v1') args.push('--ipc', 'private', '--security-opt', 'systempaths=unconfined',
      '--security-opt', `seccomp=${join(owned.directory, 'sandbox-policy.json')}`);
    for (const [key, path] of Object.entries(TASK_PATHS)) args.push('--mount', `type=bind,src=${join(owned.directory, key)},dst=${path}${key === 'config' ? ',readonly' : ''}`);
    for (const [key, value] of Object.entries(request.invocation.env ?? {})) args.push('--env', `${key}=${value}`);
    args.push('--entrypoint', request.invocation.argv[0]!, imageId, ...request.invocation.argv.slice(1));
    await docker(args);
  }

  async #inspect(resource: ExecutionResource): Promise<Inspected | null> {
    const owned = this.#owned(resource);
    let raw: string;
    try {
      raw = await docker(['inspect', '--format', '{"state":{{json .State}},"owner":{{json (index .Config.Labels "agentflow.resource")}}}', owned.name]);
    } catch {
      // Failed inspection alone does not prove absence (the daemon may be unavailable).
      const found = await docker(['container', 'ls', '--all', '--filter', `name=^/${owned.name}$`, '--format', '{{.ID}}']);
      if (found === '') return null;
      throw new Error('INSPECT_FAILED');
    }
    const data = JSON.parse(raw) as Inspected;
    if (data.owner !== resource.id || !data.state || typeof data.state.Running !== 'boolean') throw new Error('RESOURCE_OWNERSHIP_MISMATCH');
    return data;
  }

  async start(resource: ExecutionResource): Promise<void> {
    const owned = this.#owned(resource);
    const existing = await this.#inspect(resource);
    if (!existing || existing.state.Status !== 'created' || owned.attached) throw new Error('INVALID_START_STATE');
    owned.attached = attach(owned.name, join(owned.directory, 'raw', 'stdout.bin'), join(owned.directory, 'raw', 'stderr.bin'), this.#options.logBytes);
  }

  async observe(resource: ExecutionResource): Promise<Observation> {
    const owned = this.#owned(resource);
    const existing = await this.#inspect(resource);
    if (!existing) return { state: 'absent' };
    if (existing.state.Running) {
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
      files, outputsPath: join(owned.directory, 'outputs'), imageId: owned.imageId };
    return owned.capture;
  }

  async remove(resource: ExecutionResource): Promise<void> {
    const owned = this.#owned(resource);
    const existing = await this.#inspect(resource);
    if (existing?.state.Running) throw new Error('REMOVE_RUNNING_CONTAINER');
    if (existing) await docker(['rm', owned.name]);
    if (await this.#inspect(resource)) throw new Error('CONTAINER_NOT_REMOVED');
    owned.removed = true;
  }

  async release(resource: ExecutionResource): Promise<void> {
    if (this.#released.has(resource.id)) return;
    const owned = this.#owned(resource);
    if (!owned.removed) throw new Error('RESOURCE_STILL_OWNED_BY_EXECUTION');
    await rm(owned.directory, { recursive: true, force: true });
    this.#resources.delete(resource.id);
    this.#released.add(resource.id);
  }
}
