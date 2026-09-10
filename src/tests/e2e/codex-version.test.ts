import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSubscriptionRunner } from '@agentflow/integrations';
import type { CredentialStore } from '@agentflow/engine';

test('Codex composition rejects an unverified image before acquiring any credential, including cancellation', { skip: process.env['AGENTFLOW_DOCKER_TESTS'] !== '1', timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-codex-version-')); const input = join(root, 'input'); await mkdir(input);
  let acquired = false;
  const store = { acquire: async () => { acquired = true; throw new Error('MUST_NOT_ACQUIRE'); } } as unknown as CredentialStore;
  const runtime = new CodexSubscriptionRunner(store, { workspaceRoot: join(root, 'attempts'), image: 'alpine:3', proxyImage: 'alpine:3' });
  const request = { task: { identity: { runId: 'probe', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 }, prompt: 'test',
    config: { model: 'fixture-model', subagents: false, search: false } }, inputSource: input, timeoutMs: 1000,
    profile: { id: 'test', service: 'openai' as const, method: 'subscription' as const, credentialRef: 'test', endpoint: 'official' as const, capacity: 1 as const } };
  try {
    for (const cancelled of [false, true]) {
      const execution = await runtime.run(request, { requested: () => cancelled }); const result = execution.result;
      assert.equal(result.stage, 'version'); assert.equal(result.harness, null); assert.equal(result.authentication, null);
      assert.deepEqual(result.diagnostics, ['HARNESS_VERSION_NOT_VERIFIED']); assert.equal(acquired, false);
      await execution.release();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
