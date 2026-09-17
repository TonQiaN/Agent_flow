import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { discover, groupTests } from './ci/test-groups.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--group' || !['unit', 'integration', 'workflows'].includes(args[1]))) throw new Error('Use --group unit|integration|workflows, or no arguments for all tests');
const groups = groupTests(discover());
const selected = args.length ? [args[1]] : Object.keys(groups);
const artifacts = process.env.AGENTFLOW_CI_ARTIFACTS && resolve(process.env.AGENTFLOW_CI_ARTIFACTS);
if (artifacts) mkdirSync(artifacts, { recursive: true });
let count = 0;
for (const group of selected) {
  const files = groups[group];
  if (!files.length) { if (args.length) throw new Error(`No tests in ${group}`); continue; }
  count += files.length;
  // Each Docker group owns one runner/daemon; keep E2E files serial there.
  const concurrency = group === 'unit' ? Math.min(4, availableParallelism()) : 1;
  const reporters = artifacts ? ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${join(artifacts, `${group}.xml`)}`,
    '--test-reporter=./src/tooling/ci/events.mjs', `--test-reporter-destination=${join(artifacts, `${group}.ndjson`)}`] : [];
  console.log(`Test group ${group}: ${files.length} files, concurrency ${concurrency}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...reporters, ...files], {
    stdio: 'inherit', env: { ...process.env, AGENTFLOW_HISTORY_DISABLED: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
if (!count) throw new Error('No tests discovered');
