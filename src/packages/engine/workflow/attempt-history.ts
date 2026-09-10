import { validatePhaseHistory, phaseUnconfirmed } from './phases.js';
import type { ExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { canonicalJson, copyJson } from '../json.js';
import { validateRunnerResourceCheckpoint } from '../runner/checkpoint.js';
import { runnerLaunchStates } from '../runner/launch.js';
import type { WorkflowAttemptCheckpoint } from './checkpoint.js';

export const workflowAttemptIdentity = (runId: string, task: number, attempt: number): ExecutionIdentity => ({
  runId, nodeTaskId: `task-${task}`, attemptId: `attempt-${attempt}`, attemptNumber: attempt,
});
function valid(value: unknown): asserts value { if (!value) throw new DefinitionError('INVALID_WORKFLOW_ATTEMPT_HISTORY'); }
const equal = (a: unknown, b: unknown) => canonicalJson(copyJson(a)) === canonicalJson(copyJson(b));

/** Interrupted invocations keep their task position; only a recorded result advances the task. */
export function validateAttemptHistory(attempts: readonly WorkflowAttemptCheckpoint[], runId: string, steps: number) {
  valid(Array.isArray(attempts));
  const completed: WorkflowAttemptCheckpoint[] = [], positions: number[] = [], resources = new Set<string>();
  let number = 1, open: WorkflowAttemptCheckpoint | null = null;
  for (const [index, attempt] of attempts.entries()) {
    valid(attempt && typeof attempt === 'object' && !Array.isArray(attempt)
      && Object.keys(attempt).sort().join(',') === ['identity','interrupted','launch','node','resource','resultStep', ...(Object.hasOwn(attempt, 'phases') ? ['phases'] : []), ...(Object.hasOwn(attempt, 'retry') ? ['retry'] : [])].sort().join(',')
      && typeof attempt.node === 'string' && typeof attempt.interrupted === 'boolean'
      && equal(attempt.identity, workflowAttemptIdentity(runId, completed.length + 1, number)));
    positions.push(completed.length);
    if (attempt.phases !== undefined) { valid(attempt.resource === null && attempt.launch === null); validatePhaseHistory(attempt.phases, attempt.identity, resources); }
    if (attempt.resource !== null) {
      const resource = validateRunnerResourceCheckpoint(attempt.resource);
      valid(equal(resource.identity, attempt.identity) && !resources.has(resource.resource.id)); resources.add(resource.resource.id);
      valid(attempt.launch !== null && runnerLaunchStates.includes(attempt.launch));
    } else valid(attempt.launch === null);
    if (attempt.retry !== undefined) {
      valid(attempt.resultStep === null && !attempt.launch?.endsWith('_pending') && !phaseUnconfirmed(attempt.phases));
      number++; valid(Number.isSafeInteger(number));
    } else if (attempt.interrupted && attempt.resultStep === null) {
      valid(attempt.resultStep === null && !attempt.launch?.endsWith('_pending') && !phaseUnconfirmed(attempt.phases));
      number++; valid(Number.isSafeInteger(number));
    } else if (attempt.resultStep !== null) {
      valid(attempt.resultStep === completed.length && completed.length < steps);
      completed.push(attempt); number = 1;
    } else {
      valid(index === attempts.length - 1); open = attempt;
    }
  }
  valid(completed.length === steps);
  return { completed, open, positions };
}
