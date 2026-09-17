import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const execute = promisify(execFile);
const args = ['--import', resolve('src/tests/fixtures/parallel-claim-pause.mjs'), resolve('src/examples/json-parallel.mjs')];
const env: NodeJS.ProcessEnv = {...process.env, AGENTFLOW_HISTORY_DISABLED: '1'};
delete env['AGENTFLOW_STUDIO_RUN_ROOT'];
delete env['AGENTFLOW_TEST_FAIL_COORDINATOR'];
for (const kind of ['map', 'fork']) test(`${kind} example tolerates a paused claim and completes every unit`, {timeout: 30000}, async () => {
  const {stdout, stderr} = await execute(process.execPath, [...args, kind], {env, timeout: 25000});
  assert.match(stderr, /paused claim: coordinator/);
  assert.match(stderr, /paused claim: (first|second)/);
  assert.doesNotMatch(stderr, /worker error:/);
  const result = JSON.parse(stdout);
  if (kind === 'map') {
    assert.deepEqual(result.items.map((item: any) => item.id), ['a', 'b', 'c']);
    assert.deepEqual(result.items.map((item: any) => item.output.value), [2, 4, 6]);
  } else {
    assert.deepEqual(result.branches.map((branch: any) => branch.id), ['alpha', 'zeta']);
    assert.deepEqual(result.branches.map((branch: any) => branch.output.value), [14, 21]);
  }
});
test('example reports a failed coordinator before dispatching child workers', {timeout: 30000}, async () => {
  await assert.rejects(execute(process.execPath, [...args, 'map'], {env: {...env, AGENTFLOW_TEST_FAIL_COORDINATOR: '1'}, timeout: 25000}), (error: any) => {
    assert.match(error.stderr, /Worker coordinator \(batch\) failed: INJECTED_COORDINATOR_FAILURE/);
    assert.doesNotMatch(error.stderr, /paused claim: (first|second)/);
    return true;
  });
});
