import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import type { RunnerResult } from '../runner/types.js';

export interface HarnessTask {
  readonly identity: ExecutionIdentity;
  readonly prompt: string;
  readonly config: JsonValue;
  /** Omit for a single normal exit. The engine assigns that exit after contract validation. */
  readonly outcomes?: readonly string[];
}
/** A declaration, not a RunnerRequest. The host must satisfy and validate every requirement. */
export interface HarnessPlan {
  readonly harness: string;
  readonly version: string;
  readonly identity: ExecutionIdentity;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly configFiles: readonly { readonly name: string; readonly content: string }[];
  readonly authentication: { readonly service: string; readonly method: string; readonly file: string };
  readonly requirements: readonly string[];
}
export interface HarnessEvent {
  readonly identity: ExecutionIdentity;
  readonly harness: string;
  readonly sequence: number;
  readonly sourceType: string;
  readonly kind: 'lifecycle' | 'message' | 'tool' | 'usage' | 'error' | 'unknown';
  readonly itemId?: string;
  /** Only projected, redacted fields. Never the complete raw payload. */
  readonly data: JsonValue;
}
export interface HarnessUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
}
export interface HarnessEvidence {
  readonly task: HarnessTask;
  readonly runner: RunnerResult;
  readonly version: string;
  readonly stdout: Uint8Array;
  /** Provided by the authentication/logging boundary, not an Adapter secret reader. */
  readonly redact: (text: string) => string;
}
export interface HarnessResult {
  readonly identity: ExecutionIdentity;
  readonly harness: string;
  readonly status: 'completed' | 'failed';
  readonly outcome: string | null;
  readonly usage: HarnessUsage;
  readonly events: readonly HarnessEvent[];
  readonly diagnostics: readonly string[];
}
export interface HarnessAdapter {
  readonly id: string;
  plan(task: HarnessTask): HarnessPlan;
  interpret(evidence: HarnessEvidence): HarnessResult;
}
