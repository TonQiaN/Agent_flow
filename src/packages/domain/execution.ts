import type { JsonValue } from './json.js';

export type ComponentKind = 'agent' | 'gate' | 'transform' | 'effect';

/** Logical definition only: execution environment and routing are separate. */
export interface ComponentDefinition {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly inputContract: string;
  readonly outcomes: Readonly<Record<string, string>>;
  readonly implementation: string;
}

export interface ExecutionIdentity {
  readonly runId: string;
  readonly nodeTaskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
}

export interface ComponentResult {
  readonly outcome: string;
  readonly output: JsonValue;
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9]/.test(value)
    && !/[^A-Za-z0-9_.:-]/.test(value);
}

/** Validates shape, not ownership, uniqueness, allocation or retry policy. */
export function isExecutionIdentity(value: unknown): value is ExecutionIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  return isIdentifier(identity['runId']) && isIdentifier(identity['nodeTaskId'])
    && isIdentifier(identity['attemptId']) && Number.isSafeInteger(identity['attemptNumber'])
    && (identity['attemptNumber'] as number) >= 1;
}
