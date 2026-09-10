import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('compiled CLI executes a deterministic component with correlated identity', () => {
  const result = spawnSync(process.execPath, ['src/apps/cli/dist/index.js', 'demo'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { identity: { runId: 'demo-run', nodeTaskId: 'demo-task', attemptId: 'demo-attempt', attemptNumber: 1 },
    componentId: 'sum', status: 'accepted', outcome: 'completed', output: { total: 6 } });
});

test('CLI rejects unsupported commands without pretending workflow execution is available', () => {
  const result = spawnSync(process.execPath, ['src/apps/cli/dist/index.js', 'run'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage: agentflow demo/);
});
