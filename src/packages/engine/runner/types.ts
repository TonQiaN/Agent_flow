import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';

export const TASK_PATHS = Object.freeze({ input: '/task/input', work: '/task/work', outputs: '/task/outputs', state: '/task/state', config: '/task/config' });

export interface Invocation {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Host-generated, non-secret UTF-8 protocol configuration; mounted read-only. */
  readonly configFiles?: readonly { readonly name: string; readonly content: string }[];
  /** Relative to the private state directory. Raw evidence, never business outputs. */
  readonly recordFiles?: readonly { readonly id: string; readonly path: string; readonly maxBytes: number }[];
}
export interface RunnerRequest {
  readonly identity: ExecutionIdentity;
  readonly invocation: Invocation;
  readonly inputSource: string;
  readonly timeoutMs: number;
}
export interface Cancellation { requested(): boolean }
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface ExecutionResource { readonly id: string }
export type Observation = { readonly state: 'created' | 'running' | 'absent' }
  | { readonly state: 'exited'; readonly exitCode: number };
export interface CapturedFile {
  readonly path: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly error?: string;
}
export interface RawCapture {
  readonly stdout: CapturedFile;
  readonly stderr: CapturedFile;
  readonly files: Readonly<Record<string, CapturedFile>>;
  readonly outputsPath: string;
  readonly imageId: string | null;
  readonly network?: { readonly kind: 'connect-proxy'; readonly proxyImageId: string | null; readonly allowedHosts: readonly string[] };
}
export interface ExecutionBackend {
  /** Freeze and describe the actual installed execution environment before allocating resources. */
  definition?(): Promise<JsonValue>;
  /** Snapshot actual allocated ownership before any external process can be created. */
  snapshotResource?(resource: ExecutionResource, identity: ExecutionIdentity): Promise<JsonValue>;
  /** Reinstall ownership only. Must not prepare, create or start an old execution. */
  restoreResource?(snapshot: JsonValue, identity: ExecutionIdentity, expected: ExecutionResource): Promise<ExecutionResource>;
  allocate(): Promise<ExecutionResource>;
  prepare(resource: ExecutionResource, request: RunnerRequest): Promise<void>;
  create(resource: ExecutionResource, request: RunnerRequest): Promise<void>;
  start(resource: ExecutionResource): Promise<void>;
  observe(resource: ExecutionResource): Promise<Observation>;
  stop(resource: ExecutionResource): Promise<{ readonly confirmed: boolean }>;
  capture(resource: ExecutionResource): Promise<RawCapture>;
  remove(resource: ExecutionResource): Promise<void>;
  release(resource: ExecutionResource): Promise<void>;
}
export interface RunnerResourceCheckpoint {
  readonly schema: 'agentflow-runner-resource/v1';
  readonly identity: ExecutionIdentity;
  readonly resource: ExecutionResource;
  readonly execution: JsonValue;
  readonly backend: JsonValue;
}
export type RunnerLaunchState = 'allocated' | 'prepare_pending' | 'prepare_completed' | 'create_pending' | 'create_completed' | 'start_pending' | 'start_completed';
export interface RunnerResourceSink {
  save(checkpoint: RunnerResourceCheckpoint): Promise<void>;
  /** Per-invocation durable operation journal; a rejected write prevents further launch operations. */
  launch?(state: Exclude<RunnerLaunchState, 'allocated'>): Promise<void>;
}
export interface RestoredRunnerResource {
  readonly identity: ExecutionIdentity;
  readonly resource: ExecutionResource;
  query(): Promise<Observation>;
  /** Confirm both stop and removal, including a late start of a created resource. */
  stopAndRemove(): Promise<{ readonly confirmed: boolean }>;
  release(): Promise<void>;
}
export interface RunnerResult {
  readonly identity: ExecutionIdentity;
  readonly resource: ExecutionResource | null;
  readonly phase: 'exited' | 'failed' | 'cancelled' | 'timed_out';
  readonly exitCode: number | null;
  readonly stop: 'confirmed' | 'unknown' | 'not_started';
  readonly capture: RawCapture | null;
  readonly cleanup: 'removed' | 'failed' | 'blocked' | 'not_created';
  readonly diagnostics: readonly string[];
  readonly startedAt: number;
  readonly finishedAt: number;
}
