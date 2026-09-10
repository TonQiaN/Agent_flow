import type { ExecutionIdentity } from '@agentflow/domain';

export const TASK_PATHS = Object.freeze({ input: '/task/input', work: '/task/work', outputs: '/task/outputs', state: '/task/state' });

export interface Invocation {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
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
}
export interface ExecutionBackend {
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
