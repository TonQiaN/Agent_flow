import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAdapter, CLAUDE_VERSION, ClaudeSubscriptionCodec, FileCredentialStore, FileExecutionCredentialBinding, DockerBackend, systemClock } from '@agentflow/integrations';
import { Runner } from '@agentflow/engine';
import type { HarnessTask, RunnerResult } from '@agentflow/engine';

const image = process.env['AGENTFLOW_CLAUDE_IMAGE'];
test('Claude: actual pinned CLI parses the generated plan offline and reports missing login as failure despite subtype success',
  { skip: !image, timeout: 60_000 }, async () => {
    const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image!], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(inspect.status, 0); const imageId = inspect.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const version = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'claude', imageId, '--version'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(version.status, 0); assert.equal(version.stdout.trim(), `${CLAUDE_VERSION} (Claude Code)`);
    const adapter = new ClaudeAdapter(), task: HarnessTask = { identity: { runId: 'offline', nodeTaskId: 'boot', attemptId: 'first', attemptNumber: 1 },
      prompt: 'Say OK.', config: { model: 'sonnet', subagents: false, search: false }, outcomes: ['accepted', 'rejected'] }, plan = adapter.plan(task);
    const root = await mkdtemp(join(tmpdir(), 'af-claude-boot-')), name = `agentflow-claude-probe-${randomUUID()}`;
    try {
      for (const f of plan.configFiles) await writeFile(join(root, f.name), f.content, { mode: 0o644 });
      const argv = ['run', '--name', name, '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,mode=1777', '--tmpfs', '/task:rw,mode=1777'];
      for (const f of plan.configFiles) argv.push('--mount', `type=bind,src=${join(root, f.name)},dst=/task/config/${f.name},readonly`);
      for (const [key, value] of Object.entries(plan.environment)) argv.push('--env', `${key}=${value}`);
      argv.push('--entrypoint', '/bin/sh', imageId, '-c', 'mkdir -p /task/input /task/work /task/outputs /task/state/claude; cd /task/work; exec "$@"', 'probe', ...plan.argv);
      // This boots only: no credentials, no network and no successful model result.
      const actual = spawnSync('docker', argv, { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 }); assert.ifError(actual.error); assert.equal(actual.status, 1);
      const records = actual.stdout.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      assert.ok(records.some(r => r['type'] === 'system' && r['subtype'] === 'init'));
      const terminal = records.find(r => r['type'] === 'result'); assert.ok(terminal); assert.equal(terminal['subtype'], 'success'); assert.equal(terminal['is_error'], true);
      const stopped = spawnSync('docker', ['inspect', name], { timeout: 10_000 }); assert.notEqual(stopped.status, 0);
      const runner: RunnerResult = { identity: task.identity, resource: { id: name }, phase: 'exited', exitCode: actual.status, stop: 'confirmed', cleanup: 'removed', diagnostics: [], startedAt: 0, finishedAt: 1,
        capture: { imageId, outputsPath: '/task/outputs', files: {}, stdout: { path: '/probe/stdout', bytes: actual.stdout.byteLength, complete: true, truncated: false },
          stderr: { path: '/probe/stderr', bytes: actual.stderr.byteLength, complete: true, truncated: false } } };
      const result = adapter.interpret({ task, runner, stdout: actual.stdout, version: CLAUDE_VERSION, redact: text => text });
      assert.equal(result.status, 'failed'); assert.equal(result.outcome, null); assert.ok(result.diagnostics.includes('HARNESS_REPORTED_FAILURE'));
      assert.ok(!result.diagnostics.includes('MISSING_HARNESS_TERMINAL')); assert.ok(!result.diagnostics.includes('MALFORMED_HARNESS_EVENT'));
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 }); await rm(root, { recursive: true, force: true });
    }
  });

test('Claude: actual CLI recognizes a synthetic subscription file through the private binding with networking disabled',
  { skip: !image, timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-claude-format-'));
    const credential = { credentialRef: 'fixture', service: 'anthropic', method: 'subscription' };
    const content = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-original', refreshToken: 'fixture-refresh-original', expiresAt: 1800000000000,
      scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } });
    let binding: FileExecutionCredentialBinding | undefined, runner: Runner | undefined, result: RunnerResult | undefined;
    try {
      const store = new FileCredentialStore(join(root, 'store'), [new ClaudeSubscriptionCodec()]); await store.configure(credential, { content });
      const identity = { runId: 'format', nodeTaskId: 'check', attemptId: 'first', attemptNumber: 1 };
      const plan = new ClaudeAdapter().plan({ identity, prompt: 'unused', config: { model: 'sonnet', subagents: false, search: false } });
      binding = await FileExecutionCredentialBinding.acquire(store, { identity, credential, stateFile: 'claude/.credentials.json', environment: { CLAUDE_CONFIG_DIR: '/task/state/claude' } });
      const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: image!, network: 'none' }, binding); runner = new Runner(backend, systemClock);
      const input = join(root, 'input'); await mkdir(input);
      result = await runner.run({ identity, inputSource: input, timeoutMs: 10_000, invocation: {
        argv: ['/usr/bin/env', 'CLAUDE_CODE_MANAGED_SETTINGS_PATH=/task/config/claude-managed.json', 'claude', 'auth', 'status', '--json'], configFiles: plan.configFiles } });
      assert.equal(result.exitCode, 0); assert.equal(result.cleanup, 'removed');
      const status = JSON.parse(await readFile(result.capture!.stdout.path, 'utf8'));
      assert.equal(status.loggedIn, true); assert.equal(status.authMethod, 'claude.ai'); assert.equal(status.forcedLoginMethod, 'claudeai'); assert.equal(status.subscriptionType, 'max');
      // This status is a local format check: deliberately fake tokens work, so it proves no remote validity.
      assert.equal(status.email, null); assert.equal(status.orgId, null); assert.ok(!JSON.stringify(status).includes('fixture-'));
      assert.equal((await binding.finish(result)).refresh, 'unchanged'); await runner.release(result.resource!);
      assert.deepEqual(await readdir(join(root, 'attempts')), []);
      const lease = await store.acquire(credential); assert.equal(await lease.readSecret(), content); await lease.release();
    } finally {
      if (binding && result) { const final = await binding.finish(result); if (final.status !== 'released') throw new Error('CREDENTIAL_CLEANUP_RETAINED'); if (result.resource) await runner!.release(result.resource); }
      else if (binding) await binding.abandon();
      await rm(root, { recursive: true, force: true });
    }
  });
