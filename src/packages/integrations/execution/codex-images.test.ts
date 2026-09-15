import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactStore, FileManifest } from '@agentflow/engine';
import { CodexAgentDriver } from './codex-agent-driver.js';
import type { CodexSubscriptionRunner } from './codex-runner.js';

test('invalid image manifests fail before entering the credential runner', async () => {
  let calls = 0;
  const runtime = { async run() { calls++; throw new Error('TEST_STOP_BEFORE_ANY_EXECUTION'); } } as unknown as CodexSubscriptionRunner;
  const driver = new CodexAgentDriver(runtime, {} as ArtifactStore, { id: 'fixture', credentialRef: 'fixture', endpoint: 'official', service: 'openai', method: 'subscription', capacity: 1 }, { timeoutMs: 1000 });
  const task = { identity: { runId: 'r', nodeTaskId: 'n', attemptId: 'a', attemptNumber: 1 }, prompt: 'Inspect images.', config: { model: 'fixture', search: false, subagents: false, inputImages: ['page.png'] } };
  const file = { path: 'page.png', mediaType: 'image/png', bytes: 100, sha256: '0'.repeat(64), rule: 'images' };
  const manifest = (files: FileManifest['files']): FileManifest => ({ id: 'test-snapshot', contractId: 'test', directories: [], files });
  for (const files of [[], [{ ...file, mediaType: 'text/plain' }], [{ ...file, bytes: 0 }], [{ ...file, bytes: NaN }], [{ ...file, bytes: 21 * 1024 ** 2 }]]) {
    await assert.rejects(driver.run(task, manifest(files), { requested: () => false }), /INVALID_CODEX_IMAGE_MANIFEST/);
  }
  const images = Array.from({ length: 4 }, (_, i) => `${i}.png`);
  await assert.rejects(driver.run({ ...task, config: { ...task.config, inputImages: images } }, manifest(images.map(path => ({ ...file, path, bytes: 17 * 1024 ** 2 }))), { requested: () => false }), /CODEX_IMAGE_BUDGET_EXCEEDED/);
  assert.equal(calls, 0);
  await assert.rejects(driver.run(task, manifest([file]), { requested: () => false }), /SUBSCRIPTION_AGENT_START_FAILED/);
  assert.equal(calls, 1);
});
