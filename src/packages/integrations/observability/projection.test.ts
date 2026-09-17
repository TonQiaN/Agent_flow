import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRun } from './views.js';

test('run projection excludes recovery ownership and credential sources while preserving public task settings', () => {
  const identity = { runId: 'r', nodeTaskId: 'task', attemptId: 'a', attemptNumber: 1 };
  const execution = { schema: 'agentflow-docker-execution/v3', options: { image: 'sha256:test', memoryMiB: 1024, workspaceRoot: 'PRIVATE_WORKSPACE' }, paths: { input: '/task/input' }, privateState: { credentialRef: 'PRIVATE_CREDENTIAL', source: { root: 'PRIVATE_STORE' } } };
  const resource = { identity, resource: { id: 'container-1' }, execution, backend: { directory: 'PRIVATE_ATTEMPT' }, futureInternalField: 'PRIVATE_FUTURE' };
  const content = { schema: 'agentflow-workflow-checkpoint/v5', snapshot: { runId: 'r', workflowId: 'w', steps: [] },
    execution: { structure: { workflow: { id: 'w' } }, bindings: { agent: { schema: 'agentflow-credential-execution/v2', task: { prompt: 'Match evidence', config: { model: 'test' } }, environment: execution, profile: { credentialRef: 'PRIVATE_PROFILE', service: 'openai' }, authentication: { stateFile: 'PRIVATE_AUTH' } } }, resourcePlans: { agent: { phases: [{ id: 'run', kind: 'resource', execution }] } }, futureInternalField: 'PRIVATE_FUTURE' },
    attempts: [{ node: 'agent', identity, resultStep: null, launch: 'start_completed', interrupted: false, resource, phases: [{ id: 'run', kind: 'resource', status: 'active', resource, launch: 'start_completed' }], futureInternalField: 'PRIVATE_FUTURE' }], values: [] };
  const original = JSON.stringify(content);
  const result = projectRun({ runId: 'r', revision: 1, content });
  assert.ok(result);
  const text = JSON.stringify(result);
  assert.ok(!text.includes('PRIVATE_'), text);
  for (const value of ['Match evidence', 'sha256:test', '/task/input', 'container-1', 'start_completed']) assert.ok(text.includes(value));
  assert.equal(JSON.stringify(content), original, 'viewing must not mutate recovery evidence');
});
