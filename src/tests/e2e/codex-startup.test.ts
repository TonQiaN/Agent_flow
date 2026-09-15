import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runner } from '@agentflow/engine';
import { CODEX_VERSION, CodexAdapter, DockerBackend, systemClock } from '@agentflow/integrations';

const image = process.env['AGENTFLOW_CODEX_IMAGE'];
test('Codex: actual exec initializes single and structured tasks with empty or existing metadata, entirely offline',
  { skip: !image, timeout: 180_000 }, async () => {
    const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image!], { encoding: 'utf8' }).trim();
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', imageId, '--version'], { encoding: 'utf8' }).trim(), `codex-cli ${CODEX_VERSION}`);
    const root = await mkdtemp(join(tmpdir(), 'af-codex-startup-'));
    try {
      for (const existing of [false, true]) for (const structured of [false, true]) {
        const id = `${existing ? 'existing' : 'empty'}-${structured ? 'multi' : 'single'}`;
        const input = join(root, id); await mkdir(input); await writeFile(join(input, 'input.txt'), 'original');
        if (existing) {
          await mkdir(join(input, '.agents'));
          await writeFile(join(input, '.agents/task.txt'), 'user-owned metadata');
        }
        const inputImages = !existing && !structured ? Array.from({ length: 64 }, (_, i) => `page-${i}.png`) : [];
        const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
        for (const name of inputImages) await writeFile(join(input, name), pixel);
        const identity = { runId: 'startup', nodeTaskId: id, attemptId: 'first', attemptNumber: 1 };
        const plan = new CodexAdapter().plan({ identity, prompt: 'Say OK.', config: { model: 'gpt-5.6-sol', subagents: false, search: false, inputImages },
          ...(structured ? { outcomes: ['accepted', 'rejected'] } : {}) });
        const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: imageId, sandbox: 'nested-userns-v1' });
        const runner = new Runner(backend, systemClock);
        // Actual CLI and filesystem helpers, synthetic credentials, no egress. A normal
        // turn starts, then the offline request is timed out; this is not model acceptance.
        const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'fixture-id', access_token: 'fixture-access', refresh_token: 'fixture-refresh', account_id: 'fixture-account' } });
        const bootstrap = 'set -eu; mkdir -p /task/state/codex; printf %s "$1" > /task/state/codex/auth.json; shift; export CODEX_HOME=/task/state/codex; exec "$@"';
        // Blackbox ProviderBootTests gives offline Codex 25s. Five seconds can expire
        // before turn.started when the full Docker suite competes for CPU; keep the
        // startup evidence mandatory, and bound each of the four real invocations.
        const result = await runner.run({ identity, inputSource: input, timeoutMs: 25_000,
          invocation: { argv: ['/bin/sh', '-c', bootstrap, 'fixture', auth, ...plan.argv], configFiles: plan.configFiles } });
        try {
          assert.equal(result.phase, 'timed_out'); assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed');
          assert.ok(result.capture?.stdout.complete); assert.ok(result.capture?.stderr.complete);
          const stdout = await readFile(result.capture.stdout.path, 'utf8');
          const stderr = await readFile(result.capture.stderr.path, 'utf8');
          const events = stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string });
          assert.ok(events.some(event => event.type === 'thread.started'), stderr);
          assert.ok(events.some(event => event.type === 'turn.started'), stderr);
          assert.ok(!events.some(event => event.type === 'turn.completed'));
          assert.doesNotMatch(stderr, /Can't remount readonly|Failed to initialize session|fs sandbox helper failed/);
          assert.equal(await readFile(join(input, 'input.txt'), 'utf8'), 'original');
          if (existing) assert.equal(await readFile(join(input, '.agents/task.txt'), 'utf8'), 'user-owned metadata');
        } finally {
          if (result.resource) {
            if (result.cleanup !== 'removed') { assert.equal((await backend.stop(result.resource)).confirmed, true); await backend.remove(result.resource); }
            await runner.release(result.resource);
          }
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
