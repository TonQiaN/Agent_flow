import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ClaudeSubscriptionRunner, ClaudeSubscriptionCodec, FileCredentialStore, ClaudeAgentDriver, FileArtifactStore } from '@agentflow/integrations';
import { AgentExecutor, ContractRegistry, FileContractRegistry } from '@agentflow/engine';

// This executable only simulates the protocol. It never calls an auth service or a model.
const executable = `#!/usr/bin/env node
const fs=require('fs');
if(process.argv.includes('--version')){console.log('2.1.226 (Claude Code)');process.exit(0)}
if(process.cwd()!=='/task/work'||process.env.CLAUDE_CONFIG_DIR!=='/task/state/claude'||process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB!=='1'||process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY!=='1')process.exit(20);
const policy=JSON.parse(fs.readFileSync('/etc/claude-code/managed-settings.json','utf8'));
if(!policy.permissions.deny.includes('Read(//task/state/**)')||!policy.permissions.deny.includes('Edit(//task/config/**)'))process.exit(24);
if(!policy.sandbox.enabled||!policy.sandbox.failIfUnavailable||policy.sandbox.allowUnsandboxedCommands||!policy.sandbox.filesystem.allowWrite.includes('/task/input'))process.exit(21);
try{fs.writeFileSync('/etc/claude-code/managed-settings.json','changed');process.exit(22)}catch{}
if(!process.env.HTTPS_PROXY)process.exit(23);
const path=process.env.CLAUDE_CONFIG_DIR+'/.credentials.json',auth=JSON.parse(fs.readFileSync(path,'utf8'));
const original=auth.claudeAiOauth.accessToken;auth.claudeAiOauth.accessToken='fixture-access-refreshed';fs.writeFileSync(path,JSON.stringify(auth));
const input='/task/input/numbers.json',numbers=JSON.parse(fs.readFileSync(input,'utf8')).numbers;
fs.appendFileSync(input,'\\n');fs.writeFileSync('/task/outputs/answer.json',JSON.stringify({sum:numbers.reduce((a,b)=>a+b,0)}));
const schema=process.argv.indexOf('--json-schema');
const structured=schema<0?{}:{structured_output:{outcome:JSON.parse(process.argv[schema+1]).properties.outcome.enum.at(-1)}};
const prompt=process.argv.at(-1),bad=prompt==='clear'||prompt==='corrupt';
if(prompt==='clear'){auth.claudeAiOauth.accessToken='';auth.claudeAiOauth.refreshToken='';auth.claudeAiOauth.expiresAt=0;fs.writeFileSync(path,JSON.stringify(auth))}
if(prompt==='corrupt')fs.writeFileSync(path,'{torn');
for(const event of [{type:'system',subtype:'init',session_id:'fixture-session'},
 {type:'assistant',session_id:'fixture-session',message:{content:[{type:'text',text:original+' fixture-access-refreshed'}]}},
 {type:'result',session_id:'fixture-session',subtype:'success',is_error:bad,result:'finished',...structured,usage:{input_tokens:3,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}}])console.log(JSON.stringify(event));
process.exit(bad?1:0);
`;
test('Claude composition: synthetic executable exercises version, binding, refresh, redaction and output handoff without model calls',
  { skip: process.env['AGENTFLOW_EGRESS_TESTS'] !== '1', timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-claude-composition-')); const tag = `agentflow-test/claude-fixture:${randomUUID()}`;
    let built = false, passed = false;
    try {
      const build = join(root, 'build'); await mkdir(build);
      await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 claude /usr/local/bin/claude\n');
      await writeFile(join(build, 'claude'), executable);
      execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', tag, build], { stdio: 'pipe', timeout: 60_000 }); built = true;
      const input = join(root, 'input'); await mkdir(input); const original = '{"numbers":[1,2,3]}\n'; await writeFile(join(input, 'numbers.json'), original);
      const credential = { credentialRef: 'fixture', service: 'anthropic', method: 'subscription' };
      const store = new FileCredentialStore(join(root, 'store'), [new ClaudeSubscriptionCodec()]);
      await store.configure(credential, { content: JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-original', refreshToken: 'fixture-refresh-original', expiresAt: 1800000000000, scopes: ['user:inference'], subscriptionType: 'max' } }) });
      const runtime = new ClaudeSubscriptionRunner(store, { workspaceRoot: join(root, 'attempts'), image: tag, proxyImage: 'node:22-bookworm-slim' });
      const execution = await runtime.run({ task: { identity: { runId: 'composition', nodeTaskId: 'task', attemptId: 'first', attemptNumber: 1 },
        prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false } },
      profile: { id: 'test', ...credential, service: 'anthropic', method: 'subscription', endpoint: 'official', capacity: 1 }, inputSource: input, timeoutMs: 10_000 });
      try {
        const result = execution.result;
        await writeFile(join(root, 'first-execution.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        if (result.runner.capture) for (const stream of ['stdout', 'stderr'] as const) {
          const file = result.runner.capture[stream]; if (file.complete) await cp(file.path, join(root, `first-${stream}.bin`));
        }
        assert.equal(result.stage, 'execution'); assert.equal(result.harness?.status, 'completed'); assert.equal(result.harness?.outcome, null);
        assert.equal(result.authentication?.refresh, 'updated'); assert.equal(result.authentication?.credential.revision, 2); assert.deepEqual(result.diagnostics, []);
        assert.equal(result.runner.capture!.imageId, result.version.imageId); assert.equal(result.version.actual, '2.1.226');
        assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
        assert.deepEqual(JSON.parse(await readFile(join(result.runner.capture!.outputsPath, 'answer.json'), 'utf8')), { sum: 6 });
        assert.ok(!JSON.stringify(result).includes('fixture-access-'));
        const message = result.harness!.events.find(event => event.kind === 'message'); assert.deepEqual(message!.data, { blockType: 'text', text: '[redacted] [redacted]' });
        (result.runner as { cleanup: string }).cleanup = 'blocked'; assert.equal(execution.result.runner.cleanup, 'removed');
      } finally { await execution.retryCleanup(); await execution.release(); }
      await assert.rejects(runtime.definitionSnapshot({ identity: { runId: 'snapshot', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
        prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false } },
        { id: 'test', ...credential, service: 'anthropic', method: 'subscription', endpoint: 'official', capacity: 1 }, 10000), /EXECUTION_DEFINITION_AFTER_START/);
      const json = new ContractRegistry();
      json.register('input', { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'], additionalProperties: false });
      json.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
      const files = new FileContractRegistry(json);
      for (const [id, path, schema] of [['input', 'numbers.json', 'input'], ['answer', 'answer.json', 'answer']] as const) files.register(id, {
        rules: [{ id, kind: 'file', match: path, minCount: 1, maxCount: 1, mediaTypes: ['application/json'], maxBytes: 1024, jsonContract: schema }],
        maxFiles: 1, maxTotalBytes: 1024, unmatched: 'reject',
      });
      const artifacts = new FileArtifactStore(join(root, 'artifacts'), files);
      const driver = new ClaudeAgentDriver(runtime, artifacts, { id: 'test', ...credential, service: 'anthropic', method: 'subscription', endpoint: 'official', capacity: 1 },
        { timeoutMs: 10_000 });
      const coordinator = new AgentExecutor(files, artifacts, driver);
      for (const multi of [false, true]) {
        const attempt = await coordinator.execute({ componentId: 'sum', identity: { runId: 'coordinated', nodeTaskId: 'sum', attemptId: multi ? 'multi' : 'single', attemptNumber: 1 },
          prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false }, input: { source: input, contractId: 'input' },
          outcomes: multi ? { accepted: 'answer', rejected: 'answer' } : { completed: 'answer' } });
        try {
          const result = attempt.result; assert.equal(result.status, 'accepted'); if (result.status !== 'accepted') throw new Error('NOT_ACCEPTED');
          assert.equal(result.receipt.outcome, multi ? 'rejected' : 'completed'); assert.equal(result.receipt.version, '2.1.226');
          assert.equal(result.receipt.input.contractId, 'input'); assert.equal(result.receipt.output.contractId, 'answer');
          assert.ok(!JSON.stringify(attempt).includes('fixture-access')); assert.ok(!JSON.stringify(attempt).includes(root));
          const target = join(root, multi ? 'multi-result' : 'single-result'); await artifacts.materialize(result.receipt.output.id, target);
          assert.deepEqual(JSON.parse(await readFile(join(target, 'answer.json'), 'utf8')), { sum: 6 });
          assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
          await coordinator.releaseOutput(result.receipt.id);
        } finally { await attempt.retryCleanup(); await attempt.releaseExecution(); }
      }
      // A malformed refresh preserves the stored bundle and suppresses normal Harness interpretation.
      const base = { task: { identity: { runId: 'negative', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 }, prompt: 'corrupt', config: { model: 'fixture-model', subagents: false, search: false } },
        profile: { id: 'test', ...credential, service: 'anthropic' as const, method: 'subscription' as const, endpoint: 'official' as const, capacity: 1 as const }, inputSource: input, timeoutMs: 10_000 };
      const before = (await store.inspect(credential))!.revision;
      const corrupted = await runtime.run(base);
      assert.equal(corrupted.result.authentication?.refresh, 'failed'); assert.equal(corrupted.result.harness, null);
      await corrupted.release(); assert.equal((await store.inspect(credential))!.revision, before);
      const cleared = await runtime.run({ ...base, task: { ...base.task, prompt: 'clear' } });
      assert.equal(cleared.result.authentication?.refresh, 'updated'); assert.equal(cleared.result.harness?.status, 'failed'); await cleared.release();
      const lease = await store.acquire(credential); assert.equal(JSON.parse(await lease.readSecret()).claudeAiOauth.accessToken, ''); await lease.release();
      const rejected = await runtime.run({ ...base, task: { ...base.task, prompt: 'normal' } });
      assert.equal(rejected.result.runner.phase, 'failed'); assert.equal(rejected.result.authentication?.refresh, 'not_prepared'); await rejected.release();
      const wrongVersion = new ClaudeSubscriptionRunner(store, { workspaceRoot: join(root, 'version-attempts'), image: 'node:22-bookworm-slim', proxyImage: 'node:22-bookworm-slim' });
      // Hold the credential lease: the mismatched image must fail before trying to acquire it.
      const held = await store.acquire(credential);
      try { const wrong = await wrongVersion.run(base); assert.equal(wrong.result.stage, 'version'); assert.equal(wrong.result.authentication, null); await wrong.retryCleanup(); await wrong.release(); }
      finally { await held.release(); }
      assert.deepEqual(await readdir(join(root, 'attempts')), []); assert.deepEqual(await readdir(join(root, 'version-attempts')), []);
      await assert.rejects(readdir(join(root, 'driver-inputs')), { code: 'ENOENT' }); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
      passed = true;
    } finally {
      if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
      if (passed) await rm(root, { recursive: true, force: true });
      else process.stderr.write(`Retained Claude test evidence: ${root}\n`);
    }
  });
