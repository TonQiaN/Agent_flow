import { isExecutionIdentity } from '@agentflow/domain';
import { DefinitionError } from '../errors.js';
import { copyJson } from '../json.js';
import type { RunnerResourceCheckpoint } from './types.js';

/** Structural facts only; environment and backend ownership need their actual installed ports. */
export function validateRunnerResourceCheckpoint(value: unknown): RunnerResourceCheckpoint {
  let record: RunnerResourceCheckpoint;
  try { record = copyJson(value) as unknown as RunnerResourceCheckpoint; }
  catch { throw new DefinitionError('INVALID_RUNNER_RESOURCE_CHECKPOINT'); }
  if (!record || Object.keys(record).sort().join(',') !== 'backend,execution,identity,resource,schema'
    || record.schema !== 'agentflow-runner-resource/v1' || !isExecutionIdentity(record.identity)
    || Object.keys(record.identity).sort().join(',') !== 'attemptId,attemptNumber,nodeTaskId,runId'
    || !record.resource || Object.keys(record.resource).join(',') !== 'id' || typeof record.resource.id !== 'string' || !record.resource.id) throw new DefinitionError('INVALID_RUNNER_RESOURCE_CHECKPOINT');
  return record;
}
