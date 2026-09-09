import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerBackend, systemConfigMounts } from './backend.js';

test('system configuration mounts snapshot only bounded task files at canonical system destinations', () => {
  const items = [{ name: 'managed.json', target: '/etc/example/managed-settings.json' }];
  const copy = systemConfigMounts(items); items[0]!.target = '/etc/other/config.json';
  assert.equal(copy[0]!.target, '/etc/example/managed-settings.json'); assert.ok(Object.isFrozen(copy[0]));
  for (const value of [[{ name: '../secret', target: '/etc/example/config.json' }], [{ name: 'ok', target: '/task/state/secret' }],
    [{ name: 'ok', target: '/etc/passwd' }], [{ name: 'ok', target: '/etc/example/../secret' }], [{ name: 'ok', target: '/etc//example/secret' }],
    [{ name: 'ok', target: '/etc/example/secret', writable: true }], [{ name: 'ok', target: '/etc/example/secret' }, { name: 'second', target: '/etc/example/secret' }],
    [{ name: 'ok', target: '/etc/example/parent' }, { name: 'second', target: '/etc/example/parent/child' }], Array(17).fill({ name: 'ok', target: '/etc/example/file' })]) assert.throws(() => systemConfigMounts(value), /INVALID_SYSTEM_CONFIG_MOUNTS/);
});
test('missing system configuration source fails before credential preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-system-config-')); let prepared = false;
  try {
    const backend = new DockerBackend({ workspaceRoot: join(root, 'work'), image: 'fixture:latest', systemConfigMounts: [{ name: 'managed.json', target: '/etc/example/managed.json' }] },
      { environment: {}, async prepare() { prepared = true; }, async beforeRelease() {} });
    const resource = await backend.allocate(); const input = join(root, 'input'); await mkdir(input);
    await assert.rejects(backend.prepare(resource, { identity: { runId: 'run', nodeTaskId: 'node', attemptId: 'first', attemptNumber: 1 }, inputSource: input,
      timeoutMs: 1000, invocation: { argv: ['true'], configFiles: [] } }), /MISSING_SYSTEM_CONFIG_SOURCE/);
    assert.equal(prepared, false); // No container or credential was created; allocated test directory is locally owned.
  } finally { await rm(root, { recursive: true, force: true }); }
});
