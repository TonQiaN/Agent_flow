import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { CredentialStore } from '@agentflow/engine';
import { DeepSeekApiKeyRunner } from './deepseek-runner.js';
const options = { workspaceRoot: '/tmp/agentflow-assets-test', image: 'fixture:latest', proxyImage: 'node:22-bookworm-slim' };
const bundle = () => JSON.parse(execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs'], { encoding: 'utf8' }));
test('DeepSeek runtime assets export without host SDKs and require an exact bounded deployment bundle before execution', () => {
  const assets = bundle(); assert.equal(assets.version, '0.1.1-rc.2'); assert.equal(assets.files.length, 13);
  new DeepSeekApiKeyRunner({} as CredentialStore, options, assets);
  for (const patch of [{ schema: 'other' }, { version: '0.1.1' }, { extra: true }, { files: [] }, { files: [...assets.files, assets.files[0]] }])
    assert.throws(() => new DeepSeekApiKeyRunner({} as CredentialStore, options, { ...assets, ...patch }), /INVALID_DEEPSEEK_ASSETS/);
  for (const patch of [{ name: '../launch.mjs' }, { name: 'deepseek-policy/unknown.mjs' }, { content: '' }, { content: '\0' }, { content: 'x'.repeat(65537) }, { extra: true }]) {
    const files = structuredClone(assets.files); Object.assign(files[0], patch);
    assert.throws(() => new DeepSeekApiKeyRunner({} as CredentialStore, options, { ...assets, files }), /INVALID_DEEPSEEK_ASSETS/);
  }
  assert.throws(() => execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs', 'unexpected'], { stdio: 'pipe' }));
});
