// Test-only process-tree fault: a descendant holds inherited pipes after its parent exits.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import IsolatedFileSystem from '/task/config/deepseek-policy/fs-service.mjs';
import { Context } from '/task/config/deepseek-policy/sdk.mjs';
import ToolSpace from '/task/config/deepseek-policy/tool-space.mjs';
const ctx = new Context(), space = new ToolSpace(ctx), service = new IsolatedFileSystem(ctx);
const target = await service.resolve('/task/outputs/value.txt');
const original = childProcess.spawn, controller = new AbortController();
let pid, closed = false;
childProcess.spawn = (_command, _args, options) => {
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});child.on('spawn',()=>process.stderr.write('pipe_holder_ready\\n'));setInterval(()=>{},1000);`;
  const child = original(process.execPath, ['-e', script], options); pid = child.pid;
  child.stderr.on('data', bytes => { if (bytes.toString().includes('pipe_holder_ready')) { process.stderr.write('pipe_holder_ready\n'); controller.abort(); } });
  child.on('exit', () => process.stderr.write('parent_exited\n'));
  child.on('close', () => { closed = true; process.stderr.write('pipes_closed\n'); });
  return child;
};
syncBuiltinESMExports();
try {
  await assert.rejects(service.readText(target, controller.signal), { code: 'FS_ABORTED' });
  assert.ok(closed); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  // Tini may need a short interval to reap the killed descendant; no live group may remain.
  let absent = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(-pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); absent = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(absent, 'owned process group was not reaped');
  console.log('isolated_fs_tree_cancel_verified');
} finally { childProcess.spawn = original; syncBuiltinESMExports(); await space.close(); }
