// Trusted test driver for the real isolated service; all credentials and content are synthetic.
import assert from 'node:assert/strict';
import * as host from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import IsolatedFileSystem from '/task/config/deepseek-policy/fs-service.mjs';
import { Context } from '/task/config/deepseek-policy/sdk.mjs';
import ToolSpace from '/task/config/deepseek-policy/tool-space.mjs';
const ctx = new Context(), space = new ToolSpace(ctx), service = new IsolatedFileSystem(ctx);
// Test-only evidence: operation order and process lifecycle, never request content.
let sequence = 0;
const trace = (event, details = {}) => process.stderr.write(JSON.stringify({ sequence: sequence++, time: Date.now(), event, ...details }) + '\n');
for (const name of ['resolve', 'stat', 'readText', 'readBytes', 'writeText', 'closeWorker']) {
  const invoke = service[name];
  service[name] = async (...args) => {
    trace('operation-start', { method: name });
    try { const value = await invoke(...args); trace('operation-end', { method: name }); return value; }
    catch (error) { trace('operation-error', { method: name, code: error.code }); throw error; }
  };
}
const untracedSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = untracedSpawn(...args); trace('spawn', { pid: child.pid });
  const kill = child.kill.bind(child);
  child.kill = signal => { const result = kill(signal); trace('kill', { pid: child.pid, signal, sent: result }); return result; };
  child.on('exit', (code, signal) => trace('exit', { pid: child.pid, code, signal }));
  child.on('close', (code, signal) => trace('close', { pid: child.pid, code, signal }));
  child.on('error', error => trace('spawn-error', { code: error.code }));
  return child;
};
syncBuiltinESMExports();
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
} finally { await space.close(); childProcess.spawn = untracedSpawn; syncBuiltinESMExports(); }
