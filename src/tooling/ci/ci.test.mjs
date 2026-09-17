import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkGate } from './gate.mjs';
import { discover, groupTests } from './test-groups.mjs';

test('required check rejects missing, skipped, cancelled and failed jobs', () => {
  checkGate({ quality: { result: 'success' }, unit: { result: 'success' } }, ['quality', 'unit']);
  for (const result of ['failure', 'cancelled', 'skipped', 'pending', undefined]) {
    assert.throws(() => checkGate({ quality: { result: 'success' }, unit: { result } }, ['quality', 'unit']), /CI blocked/);
  }
  assert.throws(() => checkGate({ quality: { result: 'success' } }, ['quality', 'unit']), /missing/);
  assert.throws(() => checkGate({ quality: { result: 'success' }, undeclared: { result: 'success' } }, ['quality']), /undeclared/);
  assert.throws(() => checkGate({}, []), /No required/);
});
test('test groups partition every test exactly once and isolate studio acceptance', () => {
  const paths = discover(); const groups = groupTests(paths);
  assert.deepEqual(Object.values(groups).flat().sort(), paths);
  assert.equal(new Set(Object.values(groups).flat()).size, paths.length);
  const fixture = groupTests(['src/tests/e2e/studio-recruitment.test.ts', 'src/tests/e2e/docker.test.ts', 'src/packages/engine/runner.test.ts']);
  assert.equal(fixture.workflows.length, 1); assert.equal(fixture.integration.length, 1); assert.equal(fixture.unit.length, 1);
});
test('CI stage preserves child failure, timing, stdout/stderr and streamed timeout evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-ci-diagnostics-'));
  try {
    const file = join(root, 'timeout.mjs');
    writeFileSync(file, "import test from 'node:test'; test('intentional timeout', { timeout: 60 }, async () => { console.log('phase before hang'); console.error('child stderr marker'); await new Promise(resolve => setTimeout(resolve, 120)); });");
    const output = join(root, 'events.ndjson');
    const result = spawnSync(process.execPath, ['src/tooling/ci/stage.mjs', 'negative-proof', '--', process.execPath, '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${resolve('src/tooling/ci/events.mjs')}`, `--test-reporter-destination=${output}`, file], {
      encoding: 'utf8', timeout: 10000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_TEST_CONTEXT', 'GITHUB_STEP_SUMMARY'].includes(key))), AGENTFLOW_CI_ARTIFACTS: root, AGENTFLOW_CI_DOCKER: '0' },
    });
    assert.equal(result.status, 1, result.stderr);
    const stages = readFileSync(join(root, 'stages.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(stages[0].event, 'start'); assert.equal(stages.at(-1).exitCode, 1); assert.ok(stages.at(-1).durationMs > 0);
    assert.match(readFileSync(join(root, 'negative-proof.stdout.log'), 'utf8'), /phase before hang/);
    const events = readFileSync(output, 'utf8');
    assert.match(events, /test:dequeue/); assert.match(events, /child stderr marker/); assert.match(events, /testTimeoutFailure/);
    assert.ok(events.split('\n').filter(Boolean).every(line => Number.isFinite(Date.parse(JSON.parse(line).at))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
