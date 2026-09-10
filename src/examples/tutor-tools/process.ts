import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileFunctionContext } from '@agentflow/integrations';

/** Installed host function. Cancellation waits for process close before returning. */
export async function invokeTutorTool(toolchain: string, python: string, workspace: string, operation: string, ctx: FileFunctionContext, config: unknown, timeout: number) {
  const configFile = join(ctx.workPath, 'tool-context.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return new Promise<{ outcome: string }>((accept, reject) => {
    const child = spawn(python, [toolchain, operation, '--workspace', workspace, '--input', ctx.inputPath, '--output', ctx.outputsPath, '--config', configFile],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
    let stdout = '', exceeded = false, cancelled = false;
    const stop = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); } };
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) { exceeded = true; stop(); } });
    // Avoid returning student content in tool errors. The gate emits stable codes.
    child.stderr.resume();
    const deadline = setTimeout(() => { exceeded = true; stop(); }, timeout);
    const cancellation = setInterval(() => { if (ctx.cancellation.requested()) { cancelled = true; stop(); } }, 25);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(deadline); clearInterval(cancellation);
      if (code !== 0 || exceeded || cancelled) { reject(new Error(cancelled ? 'TUTOR_TOOL_CANCELLED' : exceeded ? 'TUTOR_TOOL_LIMIT' : 'TUTOR_TOOL_FAILED')); return; }
      try {
        const result = JSON.parse(stdout);
        if (Object.keys(result).join(',') !== 'outcome' || !['completed', 'passed', 'rejected'].includes(result.outcome)) throw new Error('TUTOR_TOOL_PROTOCOL');
        accept(result);
      } catch { reject(new Error('TUTOR_TOOL_PROTOCOL')); }
    });
  });
}
