import assert from 'node:assert/strict';
import { writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const invoke = (args, key) => {
  const env = { PATH: process.env.PATH }; if (key !== undefined) env.DEEPSEEK_API_KEY = key;
  const child = spawnSync(process.execPath, ['/task/config/deepseek-policy/launch.mjs', ...args], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr, 'DEEPSEEK_LAUNCH_FAILED\n');
};
// A leftover file must never become a fallback source, even if its contents are valid.
await writeFile('/task/state/deepseek-api-key.json', JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-file-must-not-be-used' }), { mode: 0o600 });
for (const key of [undefined, '', 'short', 'with space', 'line\nbreak', 'x'.repeat(8193)]) invoke(['--', 'task'], key);
for (const args of [[], ['--', ''], ['--', 'task', '--patch', '/tmp/escape'], ['task']]) invoke(args, 'fixture-valid-key');
await assert.rejects(stat('/task/state/deepseek-session.jsonl'), { code: 'ENOENT' });
console.log('private_launch_refusals_verified');
