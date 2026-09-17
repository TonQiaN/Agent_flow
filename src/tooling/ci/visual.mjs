import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--update-snapshots', '--negative-control'].includes(arg))) throw new Error('Use no arguments, --update-snapshots, or --negative-control');
const update = args.includes('--update-snapshots'), negative = args.includes('--negative-control');
if (update && process.env.CI) throw new Error('CI must compare existing baselines, never update them');
const version = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies['@playwright/test'];
if (version !== '1.63.0') throw new Error('Update the pinned visual image together with Playwright and review every baseline');
// Pinned linux/amd64 manifest, including browser and fonts. Same command on developer Mac and CI Linux.
const image = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7';
const root = resolve('.'), staging = mkdtempSync(join(tmpdir(), 'af-visual-'));
const output = resolve('.local', negative ? 'visual-negative' : update ? 'visual-baseline-update' : 'visual-comparison');
const baselines = resolve('src/tests/browser/__screenshots__');
mkdirSync(output, { recursive: true }); mkdirSync(baselines, { recursive: true });
const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (tracked.status !== 0) throw new Error(tracked.stderr);
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
writeFileSync(join(output, 'environment.json'), JSON.stringify({ image, version, platform: 'linux/amd64', sha, update, negative }, null, 2));
try {
  for (const file of new Set(tracked.stdout.split('\0').filter(Boolean))) {
    if (!lstatSync(join(root, file), { throwIfNoEntry: false })) continue;
    const destination = join(staging, file); mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, file), destination, { dereference: false, verbatimSymlinks: true });
  }
  const flags = update ? ' --update-snapshots' : negative ? ' --grep library' : '';
  const result = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--init', '--ipc=host', '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${staging}:/work`, '-v', `${output}:/evidence`, '-v', `${baselines}:/work/src/tests/browser/__screenshots__${update ? '' : ':ro'}`,
    '-w', '/work', '-e', `CI=${update ? '' : '1'}`, '-e', 'AGENTFLOW_VISUAL=1', '-e', `AGENTFLOW_VISUAL_NEGATIVE=${negative ? '1' : '0'}`,
    '-e', 'AGENTFLOW_BROWSER_DATA=/work/.local/studio-visual-tests', '-e', 'PLAYWRIGHT_OUTPUT_DIR=/evidence/test-results',
    '-e', 'PLAYWRIGHT_HTML_OUTPUT_DIR=/evidence/playwright-report', '-e', 'PLAYWRIGHT_JUNIT_OUTPUT_FILE=/evidence/browser.xml',
    image, 'sh', '-lc', `npm ci --cache /tmp/agentflow-npm-cache && npm run studio:build && npx playwright test --project=visual${flags}`], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(staging, { recursive: true, force: true }); }
