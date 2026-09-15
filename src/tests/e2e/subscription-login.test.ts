import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore, CodexSubscriptionCodec, ClaudeSubscriptionCodec, SubscriptionLoginCoordinator,
  CodexSubscriptionLoginDriver, ClaudeSubscriptionLoginDriver } from '@agentflow/integrations';
import type { DockerInteraction } from '@agentflow/integrations';

const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1' && process.env['AGENTFLOW_EGRESS_TESTS'] === '1';
const codex = { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id-token', account_id: 'fixture-account' } };
const claude = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1999999999999, scopes: ['user:inference'] } };
const identity = { runId: 'login-run', nodeTaskId: 'login-task', attemptId: 'login-attempt', attemptNumber: 1 };

// A protocol substitute exercises the product path. It never contacts an OAuth/model endpoint.
const script = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const provider=path.basename(process.argv[1]), a=process.argv.slice(2);
if(a.join(' ')==='--version'){console.log(provider==='codex'?'codex-cli 0.153.4':'2.1.226 (Claude Code)');process.exit(0);}
const expected=provider==='codex'?['login','-c','cli_auth_credentials_store="file"','--device-auth']:['auth','login','--claudeai'];
if(JSON.stringify(a)!==JSON.stringify(expected))process.exit(31);
if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN)process.exit(32);
if(!process.env.HTTPS_PROXY || process.env.NO_PROXY!=='')process.exit(33);
const dir=provider==='codex'?process.env.CODEX_HOME:process.env.CLAUDE_CONFIG_DIR;
if(fs.readdirSync(dir).length)process.exit(34);
process.stdout.write('private-fixture-device-code\\n');process.stderr.write('private-fixture-browser-link\\n');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x;if(!input.includes('\\n'))return;
const mode=input.trim();if(mode==='hang')return;
if(mode==='fail')process.exit(9);
const file=path.join(dir,provider==='codex'?'auth.json':'.credentials.json');
if(mode==='link')fs.symlinkSync('/etc/passwd',file);
else if(mode!=='missing')fs.writeFileSync(file,mode==='bad'?'{}':mode==='cleared'?JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0,scopes:['user:inference']}}):JSON.stringify(provider==='codex'?${JSON.stringify(codex)}:${JSON.stringify(claude)}),{mode:mode==='permissions'?0o644:0o600});
process.exit(0);});
`;

test('native login drivers use owned Docker, private interaction and management storage with failure isolation', { skip: !enabled, timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-native-login-')), tag = `agentflow/login-test:${Date.now()}`;
  let built = false;
  try {
    const build = join(root, 'build'); await mkdir(build);
    await writeFile(join(build, 'codex'), script); await writeFile(join(build, 'claude'), script);
    await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex claude /usr/local/bin/\n');
    execFileSync('docker', ['build', '--network', 'none', '--pull=false', '-t', tag, build], { stdio: 'pipe', timeout: 60_000 }); built = true;
    const store = new FileCredentialStore(join(root, 'store'), [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec()]);
    const coordinator = new SubscriptionLoginCoordinator(store);
    for (const provider of ['codex', 'claude'] as const) {
      await t.test(`${provider}: exact command, first-login exclusion and successful private input`, async () => {
        let disposed = 0, opened = 0, output = '', write: ((bytes: Uint8Array) => void) | undefined;
        const credential = { credentialRef: provider, service: provider === 'codex' ? 'openai' : 'anthropic', method: 'subscription' as const };
        let lockCheck: Promise<void> | undefined;
        const interaction: DockerInteraction = {
          open(input) { opened++; write = input.write; lockCheck = assert.rejects(store.acquireManagement(credential), { code: 'CREDENTIAL_BUSY' }); return () => { disposed++; }; },
          output(_channel, bytes) { output += Buffer.from(bytes).toString(); if (output.includes('device-code') && write) { write(Buffer.from('success\n')); write = undefined; } },
        };
        const options = { workspaceRoot: join(root, provider), image: tag, proxyImage: 'node:22-bookworm-slim', timeoutMs: 10_000 };
        const driver = provider === 'codex' ? new CodexSubscriptionLoginDriver(options, interaction) : new ClaudeSubscriptionLoginDriver(options, interaction);
        const attempt = await coordinator.run({ identity, credential }, driver);
        await lockCheck;
        assert.equal(attempt.result.status, 'configured', JSON.stringify(attempt.result)); assert.equal(opened, 1); assert.equal(disposed, 1);
        assert.equal(attempt.result.credential?.remoteStatus, 'unknown');
        assert.ok(!JSON.stringify([attempt, driver]).includes('fixture-')); assert.ok(output.includes('private-fixture'));
        const lease = await store.acquire(credential);
        assert.deepEqual(JSON.parse(await lease.readSecret()), provider === 'codex' ? codex : claude); await lease.release();
        assert.deepEqual(await readdir(options.workspaceRoot), []);
        await attempt.retryCleanup(); assert.equal(disposed, 1);
      });
    }
    for (const mode of ['fail', 'missing', 'bad', 'permissions', 'link', 'cancel', 'output-error'] as const) {
      await t.test(`login ${mode} never replaces the selected credential and cleans owned state`, async () => {
        const credential = { credentialRef: 'codex', service: 'openai', method: 'subscription' as const };
        const before = await store.inspect(credential); let cancelled = false, sent = false, disposed = 0;
        let input: Parameters<DockerInteraction['open']>[0];
        const interaction: DockerInteraction = { open(value) { input = value; return () => { disposed++; }; }, output() {
          if (sent) return; sent = true;
          if (mode === 'output-error') throw new Error('private-fixture-error');
          if (mode === 'cancel') { cancelled = true; input.write(Buffer.from('hang\n')); } else input.write(Buffer.from(mode + '\n'));
        } };
        const workspaceRoot = join(root, mode);
        const driver = new CodexSubscriptionLoginDriver({ workspaceRoot, image: tag, proxyImage: 'node:22-bookworm-slim', timeoutMs: 10_000 }, interaction);
        const attempt = await coordinator.run({ identity, credential }, driver, { requested: () => cancelled });
        assert.equal(attempt.result.status, 'failed', JSON.stringify(attempt.result)); assert.equal(disposed, 1);
        assert.deepEqual(await store.inspect(credential), before); assert.deepEqual(await readdir(workspaceRoot), []);
        assert.ok(!JSON.stringify(attempt).includes('private-fixture-error'));
      });
    }
    await t.test('Claude cleared refresh marker cannot configure a successful first login', async () => {
      const credential = { credentialRef: 'cleared', service: 'anthropic', method: 'subscription' as const };
      let input: Parameters<DockerInteraction['open']>[0], sent = false;
      const workspaceRoot = join(root, 'cleared');
      const driver = new ClaudeSubscriptionLoginDriver({ workspaceRoot, image: tag, proxyImage: 'node:22-bookworm-slim', timeoutMs: 10_000 }, {
        open(value) { input = value; return () => {}; }, output() { if (!sent) { sent = true; input.write(Buffer.from('cleared\n')); } },
      });
      const attempt = await coordinator.run({ identity, credential }, driver);
      assert.equal(attempt.result.status, 'failed'); assert.equal(await store.inspect(credential), null); assert.deepEqual(await readdir(workspaceRoot), []);
    });
    await t.test('failed removal retains the exact login and its lock; recovery saves once without logging in again', async () => {
      const wrappers = join(root, 'docker-wrapper'); await mkdir(wrappers);
      const originalPath = process.env['PATH'];
      const actualDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
      const flag = join(wrappers, 'fail-once');
      await writeFile(join(wrappers, 'docker'), `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2);if(a[0]==='rm'&&fs.existsSync(${JSON.stringify(flag)})){fs.unlinkSync(${JSON.stringify(flag)});process.exit(88);}const r=cp.spawnSync(${JSON.stringify(actualDocker)},a,{stdio:'inherit'});process.exit(r.status??99);\n`, { mode: 0o700 });
      const credential = { credentialRef: 'cleanup', service: 'openai', method: 'subscription' as const };
      const workspaceRoot = join(root, 'cleanup'); let opened = 0, sent = false;
      let input: Parameters<DockerInteraction['open']>[0];
      const interaction: DockerInteraction = { open(value) {
        opened++; input = value;
        // Arm only after the version probe was released. The next rm belongs to this login.
        execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"armed")', flag]);
        return () => {};
      }, output() { if (!sent) { sent = true; input.write(Buffer.from('success\n')); } } };
      process.env['PATH'] = wrappers + ':' + originalPath;
      try {
        const driver = new CodexSubscriptionLoginDriver({ workspaceRoot, image: tag, proxyImage: 'node:22-bookworm-slim', timeoutMs: 10_000 }, interaction);
        const attempt = await coordinator.run({ identity, credential }, driver);
        assert.equal(attempt.result.status, 'pending_cleanup'); assert.equal(opened, 1);
        assert.equal(await store.inspect(credential), null);
        await assert.rejects(store.acquireManagement(credential), { code: 'CREDENTIAL_BUSY' });
        assert.ok((await readdir(workspaceRoot)).length > 0); await assert.rejects(access(flag));
        await attempt.retryCleanup(); assert.equal(attempt.result.status, 'configured', JSON.stringify(attempt.result));
        assert.equal(attempt.result.credential?.revision, 1); assert.equal(opened, 1); assert.deepEqual(await readdir(workspaceRoot), []);
        await attempt.retryCleanup(); assert.equal(attempt.result.credential?.revision, 1);
      } finally { if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath; }
    });
    await t.test('wrong version and pre-cancel never open login interaction or configure an absent identity', async () => {
      for (const cancelled of [false, true]) {
        const credential = { credentialRef: 'absent', service: 'openai', method: 'subscription' as const };
        const workspaceRoot = join(root, 'version'); let opened = 0;
        const driver = new CodexSubscriptionLoginDriver({ workspaceRoot, image: 'node:22-bookworm-slim', proxyImage: 'node:22-bookworm-slim', timeoutMs: 5000 },
          { open() { opened++; return () => {}; }, output() {} });
        const result = await coordinator.run({ identity, credential }, driver, { requested: () => cancelled });
        assert.equal(result.result.status, 'failed'); assert.equal(opened, 0); assert.equal(await store.inspect(credential), null);
        assert.deepEqual(await readdir(workspaceRoot), []);
      }
    });
  } finally {
    if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});

test('selected native login CLIs advertise the configured login options without network or credentials', { skip: !enabled }, () => {
  const codexImage = process.env['AGENTFLOW_CODEX_IMAGE'], claudeImage = process.env['AGENTFLOW_CLAUDE_IMAGE'];
  assert.ok(codexImage && claudeImage, 'selected native images are required');
  assert.match(execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', codexImage, 'login', '--help'], { encoding: 'utf8', timeout: 15_000 }), /--device-auth/);
  assert.match(execFileSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'claude', claudeImage, 'auth', 'login', '--help'], { encoding: 'utf8', timeout: 15_000 }), /--claudeai/);
});
