import assert from 'node:assert/strict';
import { writeFile, rm, symlink, link, chmod, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const path = '/task/state/deepseek-api-key.json', secret = 'fixture-secret-key';
const invoke = args => {
  const child = spawnSync(process.execPath, ['/task/config/deepseek-policy/launch.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr, 'DEEPSEEK_LAUNCH_FAILED\n');
};
invoke(['--', 'task']);
for (const payload of ['not json', '{}', JSON.stringify({ schema: 'other', api_key: secret }), JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'with space' }), 'x'.repeat(16385)]) {
  await writeFile(path, payload, { mode: 0o600 }); invoke(['--', 'task']); await rm(path);
}
await writeFile('/task/state/original-key', JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: secret }), { mode: 0o600 });
await symlink('/task/state/original-key', path); invoke(['--', 'task']); await rm(path);
await link('/task/state/original-key', path); invoke(['--', 'task']); await rm(path);
await writeFile(path, JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: secret }), { mode: 0o600 });
await chmod(path, 0o644); invoke(['--', 'task']); await chmod(path, 0o600);
for (const args of [[], ['--', ''], ['--', 'task', '--patch', '/tmp/escape'], ['task']]) invoke(args);
await assert.rejects(stat('/task/state/deepseek-session.jsonl'), { code: 'ENOENT' });
console.log('private_launch_refusals_verified');
