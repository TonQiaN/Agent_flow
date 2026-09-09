import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

function testsAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'dist' || entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testsAt(path) : /\.test\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const tests = testsAt('src').sort();
if (!tests.length) throw new Error('No tests discovered');
// Native CLI/Docker E2E files share the same daemon. Isolate file-level resource demand;
// explicit concurrency inside a test remains part of the behavior under test.
const e2e = tests.filter(path => path.startsWith(join('src', 'tests', 'e2e') + sep));
const unit = tests.filter(path => !e2e.includes(path));
for (const [files, concurrency] of [[unit, Math.min(4, availableParallelism())], [e2e, 1]]) {
  if (!files.length) continue;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
