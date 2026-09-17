import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export function dockerState(root) {
  const result = spawnSync('docker', ['ps', '-a', '--format', '{{json .ID}}\t{{json .Names}}\t{{json .State}}\t{{json .Status}}'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'docker-state.ndjson'), JSON.stringify({ at: new Date().toISOString(), exitCode: result.status,
    error: result.error?.code, containers: result.stdout?.trim().split('\n').filter(Boolean) ?? [] }) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) dockerState(resolve(process.env.AGENTFLOW_CI_ARTIFACTS ?? '.local/ci'));
