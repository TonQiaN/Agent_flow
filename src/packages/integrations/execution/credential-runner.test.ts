import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessResult } from '@agentflow/engine';
import { CredentialExecution } from './credential-runner.js';
import { ExecutionLogCapture } from '../observability/logs.js';

test('a failing optional log sink does not change a successful harness outcome', async () => {
  const identity = { runId: 'r', nodeTaskId: 'n', attemptId: 'a', attemptNumber: 1 };
  const harness: HarnessResult = { identity, harness: 'fixture', status: 'completed', outcome: 'ok', events: [], diagnostics: [],
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: null } };
  const logs = new ExecutionLogCapture(identity, async () => { throw new Error('disk full'); }, text => text);
  const args = ['execution', { capture: { imageId: 'image', stdout: { complete: false }, files: {} } }, {}, {},
    { expected: '1', actual: '1', imageId: 'image' }, { finish: async () => ({ status: 'released', refresh: 'unchanged' }) },
    { redact: (text: string) => text }, { identity, prompt: 'test', config: {} }, [], { interpret: () => harness }, [], logs] as unknown as ConstructorParameters<typeof CredentialExecution>;
  const execution = new CredentialExecution(...args);
  await execution.interpret();
  assert.deepEqual(execution.result.harness, harness);
  assert.ok(execution.result.diagnostics.includes('LOG_CAPTURE_INCOMPLETE'));
});
