// Trusted test driver for the real isolated service; all credentials and content are synthetic.
import assert from 'node:assert/strict';
import * as host from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import IsolatedFileSystem from '/task/config/deepseek-policy/fs-service.mjs';
import { Context } from '/task/config/deepseek-policy/sdk.mjs';
import ToolSpace from '/task/config/deepseek-policy/tool-space.mjs';
const ctx = new Context(), space = new ToolSpace(ctx), service = new IsolatedFileSystem(ctx);
try {
  const temporary = await service.resolve('/tmp/persistent.txt');
  await service.writeText(temporary, '跨请求临时文件');
  assert.equal(await service.readText(temporary), '跨请求临时文件');
  await assert.rejects(service.writeText(temporary, 'denied', undefined, undefined, { mode: 'read-only' }), { code: 'FS_PERMISSION_DENIED' });
  const output = await service.resolve('/task/outputs/value.txt');
  await service.writeText(output, 'one');
  const first = await service.stat(output);
  await service.writeText(output, 'two', { kind: 'replaceIfVersion', version: first.version });
  await assert.rejects(service.writeText(output, 'stale', { kind: 'replaceIfVersion', version: first.version }), { code: 'FS_STALE_VERSION' });
  await assert.rejects(service.writeText(output, 'denied', undefined, undefined, { mode: 'read-only' }));
  await assert.rejects(service.writeText(output, 'denied', undefined, undefined, { mode: 'danger-full-access' }), { code: 'FS_PERMISSION_DENIED' });
  assert.equal(await service.readText(output), 'two');
  await host.writeFile('/task/input/binary.bin', Buffer.from([0, 1, 255, 128]));
  const binary = await service.resolve('/task/input/binary.bin');
  assert.deepEqual([...await service.readBytes(binary, undefined, 4)], [0, 1, 255, 128]);
  await assert.rejects(service.readText(binary), { code: 'FS_NOT_TEXT' });
  await assert.rejects(service.readBytes(binary, undefined, 3), { code: 'FS_TOO_LARGE' });
  await host.writeFile('/task/input/large.txt', 'a'.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(service.readText(await service.resolve('/task/input/large.txt')), { code: 'FS_TOO_LARGE' });
  // Read raw bytes to avoid mistaking a text-format refusal for environment isolation.
  const environment = Buffer.from(await service.readBytes(await service.resolve('/proc/self/environ'), undefined, 65536)).toString();
  assert.ok(!environment.includes('fixture-parent-secret')); assert.ok(!environment.includes('DEEPSEEK_API_KEY'));
  const mounts = await service.readText(await service.resolve('/proc/self/mounts'));
  assert.match(mounts.split('\n').find(line => line.split(' ')[1] === '/tmp'), /noexec/);
  const controller = new AbortController(), original = childProcess.spawn;
  let pid, closed = false;
  childProcess.spawn = (...args) => {
    const child = original(...args); pid = child.pid;
    child.on('close', () => { closed = true; });
    process.nextTick(() => controller.abort());
    return child;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(service.readText(output, controller.signal), { code: 'FS_ABORTED' }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.ok(pid); assert.ok(closed); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(await service.readText(output), 'two');
  await service.closeWorker();
  await assert.rejects(service.readText(output), { code: 'FS_ABORTED' });
  await space.close();
  assert.deepEqual((await host.readdir('/tmp')).filter(name => name.startsWith('agentflow-tools-')), []);
  console.log('isolated_fs_seam_verified');
} finally { await space.close(); }
