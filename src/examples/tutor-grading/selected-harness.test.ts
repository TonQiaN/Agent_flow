import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactStore } from '@agentflow/engine';
import { selectGradingHarness } from './selected-harness.js';

test('matrix preflight validates all three compositions without credentials, Docker or output directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-matrix-preflight-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [harness, version] of [['codex', '0.153.4'], ['claude', '2.1.226'], ['deepseek', '0.1.1-rc.2']] as const) {
    const environment = { ...process.env, AGENTFLOW_ACCEPTANCE_HARNESS: harness, AGENTFLOW_ACCEPTANCE_ROOT: join(root, 'evidence'),
      AGENTFLOW_CREDENTIAL_STORE: join(root, 'missing-store'), AGENTFLOW_CREDENTIAL_REF: 'explicit', AGENTFLOW_PROXY_IMAGE: 'missing-proxy',
      [`AGENTFLOW_${harness.toUpperCase()}_IMAGE`]: 'missing-image', [`AGENTFLOW_${harness.toUpperCase()}_MODEL`]: harness === 'deepseek' ? 'deepseek-v4-flash' : 'fixture-model' };
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/examples/tutor-grading/matrix.ts', '--preflight'], { env: environment, encoding: 'utf8' }));
    assert.equal(result.expectedVersion, version); assert.equal(result.harness, harness); assert.equal(result.validated, 'configuration-only');
    assert.equal(result.credentialsRead, false); assert.equal(result.imageInspected, false); assert.equal(result.networkCalled, false);
    // Construct the actual selected runtime/driver too: this validates DeepSeek deployment assets, without running anything.
    const selected = selectGradingHarness(harness, environment), driver = selected.driver({} as ArtifactStore, root);
    assert.equal(driver.harness, harness);
    driver.validate({ identity: { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 }, prompt: 'same business task', config: selected.config });
    const missing: NodeJS.ProcessEnv = { ...environment }; delete missing.AGENTFLOW_CREDENTIAL_STORE;
    const rejected = spawnSync(process.execPath, ['--import', 'tsx', 'src/examples/tutor-grading/matrix.ts', '--preflight'], { env: missing, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /MISSING_GRADING_CONFIGURATION/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('matrix entry rejects unknown providers and extra execution arguments before side effects', () => {
  for (const [value, args] of [['unknown', []], ['codex', ['--preflight', '--run']]] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/examples/tutor-grading/matrix.ts', ...args], {
      env: { ...process.env, AGENTFLOW_ACCEPTANCE_HARNESS: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /INVALID_ACCEPTANCE_(HARNESS|ARGUMENTS)/);
  }
});


test('preflight preserves shared credential identifiers and rejects trailing line breaks', () => {
  const environment = { AGENTFLOW_ACCEPTANCE_ROOT: '/tmp/unused-acceptance', AGENTFLOW_CREDENTIAL_STORE: '/tmp/unused-store',
    AGENTFLOW_CREDENTIAL_REF: 'valid', AGENTFLOW_PROXY_IMAGE: 'unused', AGENTFLOW_CODEX_IMAGE: 'unused', AGENTFLOW_CODEX_MODEL: 'fixture-model' };
  assert.throws(() => selectGradingHarness('codex', { ...environment, AGENTFLOW_CREDENTIAL_REF: 'valid\n' }), /INVALID_GRADING_REFERENCE/);
  assert.doesNotThrow(() => selectGradingHarness('codex', { ...environment, AGENTFLOW_CREDENTIAL_REF: 'scope:identity' }));
  assert.equal(selectGradingHarness('codex', environment).preflight.timeoutPerNodeMs, 180000);
  assert.equal(selectGradingHarness('codex', environment, { timeoutMs: 1800000 }).preflight.timeoutPerNodeMs, 1800000);
  for (const timeoutMs of [0, NaN, 5400001]) assert.throws(() => selectGradingHarness('codex', environment, { timeoutMs }), /INVALID_GRADING_TIMEOUT/);
});
