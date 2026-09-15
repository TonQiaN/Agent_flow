import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
export const retryCategories = ['timeout', 'execution_failure', 'interrupted'] as const;
export type RetryCategory = typeof retryCategories[number];
export interface RetryPolicy { readonly maxAttempts: number; readonly on: readonly RetryCategory[]; readonly delayMs: number }
export interface RetryDecision { readonly category: RetryCategory; readonly decidedAt: number; readonly nextAt: number }
export function validateRetryPolicy(raw: unknown): RetryPolicy {
  const p = copyJson(raw) as unknown as RetryPolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'delayMs,maxAttempts,on'
    || !Number.isSafeInteger(p.maxAttempts) || p.maxAttempts < 1 || p.maxAttempts > 100
    || !Number.isSafeInteger(p.delayMs) || p.delayMs < 0 || p.delayMs > 86400000
    || !Array.isArray(p.on) || new Set(p.on).size !== p.on.length || !p.on.every(c => retryCategories.includes(c))) throw new DefinitionError('INVALID_RETRY_POLICY');
  return p;
}
/** Codes are emitted by trusted executors, never inferred from model text. Unknown codes do not match. */
export function retryCategory(code: string): RetryCategory | null {
  if (code === 'EXECUTION_TIMEOUT') return 'timeout';
  if (code === 'ATTEMPT_INTERRUPTED') return 'interrupted';
  if (['SCRIPT_EXECUTION_FAILED', 'EXECUTION_NOT_SUCCESSFUL', 'HARNESS_NOT_SUCCESSFUL', 'IMPLEMENTATION_FAILED', 'FILE_NODE_EXECUTION_FAILED'].includes(code)) return 'execution_failure';
  return null;
}
export function decideRetry(policy: RetryPolicy | undefined, used: number, code: string, stopped: boolean, cancelled: boolean, now: number): RetryDecision | null {
  if (!Number.isSafeInteger(used) || used < 1 || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) throw new DefinitionError('INVALID_RETRY_FACTS');
  if (!policy) return null;
  const p = validateRetryPolicy(policy), category = retryCategory(code);
  if (!stopped || cancelled || used >= p.maxAttempts || category === null || !p.on.includes(category)) return null;
  const nextAt = now + p.delayMs;
  if (!Number.isFinite(nextAt) || nextAt > Number.MAX_SAFE_INTEGER) throw new DefinitionError('INVALID_RETRY_FACTS');
  return { category, decidedAt: now, nextAt };
}
