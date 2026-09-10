import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileCredentialStore, CodexSubscriptionCodec, ClaudeSubscriptionCodec } from '@agentflow/integrations';
const cli = resolve('src/apps/cli/dist/index.js');
const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1' && process.env['AGENTFLOW_EGRESS_TESTS'] === '1';
const codex = { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id-token', account_id: 'fixture-account' } };
const claude = { claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1999999999999, scopes: ['user:inference'] } };
const invoke = (args: string[], input?: string) => spawnSync(process.execPath, [cli, 'auth', ...args], { encoding: 'utf8', timeout: 5000, ...(input ? { input } : {}) });

test('login CLI validates explicit selection and refuses redirected credentials before creating state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-login-cli-args-'));
  try {
    const store = join(root, 'store'), workspace = join(root, 'workspace');
    const args = ['login', 'codex', '--store', store, '--credential-ref', 'terminal', '--workspace', workspace, '--image', 'alpine:3', '--proxy-image', 'alpine:3'];
    const piped = invoke(args, 'fixture-piped-code\n'); assert.equal(piped.status, 1); assert.equal(piped.stderr, 'AUTH_LOGIN_REQUIRES_TERMINAL\n'); assert.equal(piped.stdout, '');
    for (const extra of [['--code', 'fixture-argv-code'], ['--file', '/fixture/file'], ['--store', store], ['--timeout-ms', '0'], ['--timeout-ms', '1800001'], ['--timeout-ms', '1e3'], ['--json', 'true']]) {
      const result = invoke([...args, ...extra]); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes('fixture-argv-code'));
    }
    assert.equal(invoke(['login', 'deepseek', ...args.slice(2)]).status, 2);
    await assert.rejects(access(store)); await assert.rejects(access(workspace));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subscription inspect and local delete share the selected service identity without login or network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-login-cli-manage-'));
  try {
    for (const provider of ['codex', 'claude'] as const) {
      const storeRoot = join(root, provider), store = new FileCredentialStore(storeRoot, [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec()]);
      const identity = { credentialRef: 'selected', service: provider === 'codex' ? 'openai' : 'anthropic', method: 'subscription' };
      await store.configure(identity, { content: JSON.stringify(provider === 'codex' ? codex : claude) });
      const args = [provider, '--store', storeRoot, '--credential-ref', 'selected'];
      const inspected = invoke(['inspect', ...args]); assert.equal(inspected.status, 0); assert.equal(JSON.parse(inspected.stdout).remoteStatus, 'unknown');
      assert.ok(!inspected.stdout.includes('fixture-')); const deleted = invoke(['delete', ...args]);
      assert.equal(deleted.status, 0); assert.deepEqual(JSON.parse(deleted.stdout), { deleted: true, remoteRevoked: false });
      assert.equal(invoke(['inspect', ...args]).stdout, 'null\n');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compiled subscription login CLI: actual terminal input, owned Docker, cancellation, timeout and restoration', { skip: !enabled, timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-login-cli-pty-')), tag = `agentflow/login-cli-test:${Date.now()}`; let built = false;
  try {
    const build = join(root, 'build'); await mkdir(build);
    const script = `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),provider=path.basename(process.argv[1]);
if(process.argv[2]==='--version'){console.log(provider==='codex'?'codex-cli 0.153.4':'2.1.226 (Claude Code)');process.exit(0);}
if(process.env.OPENAI_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN)process.exit(33);
process.stdout.write('\\x1b]52;c;fixture-display-only\\x07fixture-authorization-ready\\n');
let code='';process.stdin.on('data',b=>{code+=b.toString();if(!code.includes('\\n'))return;if(code!=='fixture-auth-code\\n')process.exit(9);
const dir=provider==='codex'?process.env.CODEX_HOME:process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(dir,provider==='codex'?'auth.json':'.credentials.json'),JSON.stringify(provider==='codex'?${JSON.stringify(codex)}:${JSON.stringify(claude)}),{mode:0o600});process.exit(0);});
`;
    await writeFile(join(build, 'codex'), script); await writeFile(join(build, 'claude'), script);
    await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex claude /usr/local/bin/\n');
    execFileSync('docker', ['build', '--network', 'none', '--pull=false', '-t', tag, build], { stdio: 'pipe', timeout: 60_000 }); built = true;
    for (const provider of ['codex', 'claude'] as const) {
      const modes = provider === 'claude' ? ['success', 'edit'] : ['success', 'cancel', 'eof', 'signal', 'early-signal', 'invalid', 'oversized', 'multiline', 'timeout', 'cleanup-pending'];
      for (const mode of modes.filter(x => !process.env['AGENTFLOW_LOGIN_TEST_MODE'] || x === process.env['AGENTFLOW_LOGIN_TEST_MODE'])) await t.test(`${provider} ${mode}`, async () => {
        const path = join(root, provider + '-' + mode); await mkdir(path);
        const storeRoot = join(path, 'store'), workspace = join(path, 'workspace');
        const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: 'fixture-ambient-wrong', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-ambient-wrong' };
        const actualDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
        if (mode === 'cleanup-pending') {
          const wrappers = join(path, 'wrappers'), counter = join(path, 'removals'); await mkdir(wrappers);
          // Permit version-probe removal, then fail both ordinary login removal and its one retry.
          await writeFile(join(wrappers, 'docker'), `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2),p=${JSON.stringify(counter)};if(a[0]==='rm'){const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));if(n>=1)process.exit(88);}const r=cp.spawnSync(${JSON.stringify(actualDocker)},a,{stdio:'inherit'});process.exit(r.status??99);\n`, { mode: 0o700 });
          env['PATH'] = wrappers + ':' + process.env['PATH'];
        }
        const result = spawnSync('python3', ['src/tests/fixtures/login-terminal.py', process.execPath, cli, storeRoot, workspace, tag, provider, mode], { encoding: 'utf8', timeout: 60000,
          env });
        assert.equal(result.status, 0, result.stderr);
        const proof = JSON.parse(result.stdout); assert.equal(proof.hidden, true); assert.equal(proof.restored, true); assert.equal(proof.leaked, false); assert.equal(proof.controls, false);
        const identity = { credentialRef: 'terminal', service: provider === 'codex' ? 'openai' : 'anthropic', method: 'subscription' };
        const store = new FileCredentialStore(storeRoot, [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec()]);
        if (mode === 'cleanup-pending') {
          const owned = execFileSync(actualDocker, ['container', 'ls', '--all', '--filter', `label=agentflow.attempt=${proof.status.identity.attemptId}`, '--format', '{{.Names}}\t{{.Label "agentflow.resource"}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(row => row.split('\t'));
          const resources = [...new Set(owned.map(row => row[1]!))];
          try {
            assert.equal(proof.exit, 3); assert.equal(proof.status.status, 'pending_cleanup'); assert.equal(proof.diagnostic, 'AUTH_LOGIN_CLEANUP_PENDING');
            // Task and proxy carry the same complete Attempt identity after resource recovery was added.
            assert.equal(resources.length, 1); assert.match(resources[0]!, /^af-[a-f0-9-]{36}$/);
            assert.deepEqual(owned.map(row => row[0]).sort(), [resources[0], `${resources[0]}-proxy`].sort());
            assert.ok((await readdir(workspace)).length > 0); assert.equal(await store.inspect(identity), null);
            await assert.rejects(store.acquireManagement(identity), { code: 'CREDENTIAL_BUSY' });
          } finally {
            // Explicitly dispose only the synthetic execution identified by this returned attempt.
            for (const resource of resources) {
              const names = execFileSync(actualDocker, ['container', 'ls', '--all', '--filter', `label=agentflow.resource=${resource}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
              if (names.length) execFileSync(actualDocker, ['rm', '--force', ...names], { stdio: 'pipe' });
              const networks = execFileSync(actualDocker, ['network', 'ls', '--filter', `label=agentflow.resource=${resource}`, '--format', '{{.Name}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
              if (networks.length) execFileSync(actualDocker, ['network', 'rm', ...networks], { stdio: 'pipe' });
            }
          }
          return;
        }
        if (mode === 'success' || mode === 'edit') {
          assert.equal(proof.exit, 0); assert.equal(proof.status.status, 'configured'); assert.equal(proof.status.credential.remoteStatus, 'unknown');
          const lease = await store.acquire(identity); assert.deepEqual(JSON.parse(await lease.readSecret()), provider === 'codex' ? codex : claude); await lease.release();
        } else {
          assert.equal(proof.exit, 1, JSON.stringify(proof)); assert.equal(proof.status.status, 'failed'); assert.equal(await store.inspect(identity), null);
          assert.equal(proof.diagnostic, mode === 'timeout' ? 'AUTH_LOGIN_TIMEOUT' : ['invalid', 'oversized', 'multiline'].includes(mode) ? 'AUTH_LOGIN_INPUT_INVALID' : 'AUTH_LOGIN_CANCELLED');
        }
        try { assert.deepEqual(await readdir(workspace), []); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        const lease = await store.acquireManagement(identity); await lease.release();
      });
    }
  } finally {
    if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
