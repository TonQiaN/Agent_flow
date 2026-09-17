import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dockerState } from './docker-state.mjs';
const [label, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label ?? '') || separator !== '--' || !command) throw new Error('Usage: stage.mjs <label> -- <command> [args]');
const root = resolve(process.env.AGENTFLOW_CI_ARTIFACTS ?? '.local/ci');
mkdirSync(root, { recursive: true });
const started = performance.now();
const record = value => appendFileSync(join(root, 'stages.ndjson'), JSON.stringify({ at: new Date().toISOString(), label, ...value }) + '\n');
writeFileSync(join(root, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  sha: process.env.GITHUB_SHA, head: process.env.CI_HEAD_SHA, base: process.env.CI_BASE_SHA,
  run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB }, null, 2));
record({ event: 'start' });
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, AGENTFLOW_CI_ARTIFACTS: root } });
const limit = 8 * 1024 * 1024;
for (const channel of ['stdout', 'stderr']) {
  let bytes = 0;
  child[channel].on('data', chunk => {
    process[channel].write(chunk);
    const keep = chunk.subarray(0, Math.max(0, limit - bytes));
    if (keep.length) appendFileSync(join(root, `${label}.${channel}.log`), keep);
    bytes += chunk.length;
    if (bytes - chunk.length < limit && bytes >= limit) appendFileSync(join(root, `${label}.${channel}.log`), '\n[CI log limit reached]\n');
  });
}
const snapshot = () => { try { dockerState(root); } catch (error) { record({ event: 'diagnostic-error', message: error.message }); } };
const sample = process.env.AGENTFLOW_CI_DOCKER === '1';
if (sample) snapshot();
const timer = sample ? setInterval(snapshot, 15000) : undefined;
const onSignal = signal => { record({ event: 'signal', signal }); child.kill(signal); };
process.on('SIGTERM', () => onSignal('SIGTERM')); process.on('SIGINT', () => onSignal('SIGINT'));
child.on('error', error => record({ event: 'spawn-error', message: error.message }));
child.on('close', (code, signal) => {
  clearInterval(timer); if (sample) snapshot();
  const durationMs = Math.round(performance.now() - started);
  record({ event: 'end', durationMs, exitCode: code, signal });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${label} | ${code === 0 ? 'passed' : 'failed'} | ${(durationMs / 1000).toFixed(1)}s |\n`);
  process.exitCode = code ?? 1;
});
