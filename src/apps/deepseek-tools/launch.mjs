import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { captureDeepseekSession } from './session-capture.mjs';

async function privateKey() {
  for (const path of ['/task', '/task/state']) if (!(await lstat(path)).isDirectory()) throw new Error();
  const file = await open('/task/state/deepseek-api-key.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || stat.size < 1 || stat.size > 16384) throw new Error();
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    const after = await file.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error();
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'api_key,schema'
      || data.schema !== 'agentflow-deepseek-key/v1' || typeof data.api_key !== 'string' || !/^[\x21-\x7e]{8,8192}$/.test(data.api_key)) throw new Error();
    return data.api_key;
  } finally { await file.close(); }
}
const groupExists = pid => { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--' || !args[1].trim() || args[1].includes('\0') || args[1].length > 65536) throw new Error();
  const version = JSON.parse(await readFile('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', 'utf8')).version;
  if (version !== '0.1.1-rc.2') throw new Error();
  const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/task/state/deepseek', DSH_HOME: '/task/state/deepseek',
    DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
    NARB_DISABLE_NATIVE_CACHE: '1', NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: await privateKey() };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
    const value = process.env[key]; if (value !== undefined) {
      if (value.length > 2048 || /[\0\r\n]/.test(value)) throw new Error(); environment[key] = value;
    }
  }
  const child = spawn('/usr/local/bin/dsh', ['--profile', 'headless', '--patch', '/task/config/deepseek.json', '--', '--', args[1]],
    { cwd: '/task/work', env: environment, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  let interrupted = false, escalation;
  const cancel = () => {
    interrupted = true;
    if (child.pid) signalGroup(child.pid, 'SIGTERM');
    escalation ??= setTimeout(() => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); }, 1000);
  };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const residual = child.pid ? groupExists(child.pid) : true;
    if (residual && child.pid) signalGroup(child.pid, 'SIGKILL');
    if (interrupted || residual || outcome.code !== 0 || outcome.signal !== null) throw new Error();
    await captureDeepseekSession();
    if (interrupted) { await unlink('/task/state/deepseek-session.jsonl'); throw new Error(); }
  } finally {
    clearTimeout(escalation); process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    if (child.pid && groupExists(child.pid)) signalGroup(child.pid, 'SIGKILL');
  }
}
try { await main(); } catch { process.stderr.write('DEEPSEEK_LAUNCH_FAILED\n'); process.exitCode = 1; }
