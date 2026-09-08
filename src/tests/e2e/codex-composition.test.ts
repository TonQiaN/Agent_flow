import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CodexSubscriptionRunner, CodexSubscriptionCodec, FileCredentialStore } from '@agentflow/integrations';

// This executable only simulates the protocol. It never calls an auth service or a model.
const executable = `#!/usr/bin/env node
const fs=require('fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}
const path=process.env.CODEX_HOME+'/auth.json',auth=JSON.parse(fs.readFileSync(path,'utf8'));
const original=auth.tokens.access_token;auth.tokens.access_token='fixture-access-refreshed';fs.writeFileSync(path,JSON.stringify(auth));
const input='/task/input/numbers.json',numbers=JSON.parse(fs.readFileSync(input,'utf8')).numbers;
fs.appendFileSync(input,'\\n');fs.writeFileSync('/task/outputs/answer.json',JSON.stringify({sum:numbers.reduce((a,b)=>a+b,0)}));
for(const event of [{type:'thread.started',thread_id:'fixture-thread'},{type:'turn.started'},
 {type:'item.completed',item:{id:'message',type:'agent_message',text:original+' '+auth.tokens.access_token}},
 {type:'turn.completed',usage:{input_tokens:3,output_tokens:1}}])console.log(JSON.stringify(event));
`;
test('Codex composition: synthetic executable exercises version, binding, refresh, redaction and output handoff without model calls',
  { skip: process.env['AGENTFLOW_EGRESS_TESTS'] !== '1', timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-codex-composition-')); const tag = `agentflow-test/codex-fixture:${randomUUID()}`;
    let built = false;
    try {
      const build = join(root, 'build'); await mkdir(build);
      await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex /usr/local/bin/codex\n');
      await writeFile(join(build, 'codex'), executable);
      execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', tag, build], { stdio: 'pipe', timeout: 60_000 }); built = true;
      const input = join(root, 'input'); await mkdir(input); const original = '{"numbers":[1,2,3]}\n'; await writeFile(join(input, 'numbers.json'), original);
      const credential = { credentialRef: 'fixture', service: 'openai', method: 'subscription' };
      const store = new FileCredentialStore(join(root, 'store'), [new CodexSubscriptionCodec()]);
      await store.configure(credential, { content: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'fixture-id-original', access_token: 'fixture-access-original', refresh_token: 'fixture-refresh-original', account_id: 'fixture-account' } }) });
      const runtime = new CodexSubscriptionRunner(store, { workspaceRoot: join(root, 'attempts'), image: tag, proxyImage: 'node:22-bookworm-slim' });
      const execution = await runtime.run({ task: { identity: { runId: 'composition', nodeTaskId: 'task', attemptId: 'first', attemptNumber: 1 },
        prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false } },
      profile: { id: 'test', ...credential, service: 'openai', method: 'subscription', endpoint: 'official', capacity: 1 }, inputSource: input, timeoutMs: 10_000 });
      try {
        const result = execution.result;
        assert.equal(result.stage, 'execution'); assert.equal(result.harness?.status, 'completed'); assert.equal(result.harness?.outcome, null);
        assert.equal(result.authentication?.refresh, 'updated'); assert.equal(result.authentication?.credential.revision, 2); assert.deepEqual(result.diagnostics, []);
        assert.equal(result.runner.capture!.imageId, result.version.imageId); assert.equal(result.version.actual, '0.153.4');
        assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
        assert.deepEqual(JSON.parse(await readFile(join(result.runner.capture!.outputsPath, 'answer.json'), 'utf8')), { sum: 6 });
        assert.ok(!JSON.stringify(result).includes('fixture-access-'));
        const message = result.harness!.events.find(event => event.kind === 'message'); assert.deepEqual(message!.data, { itemType: 'agent_message', text: '[redacted] [redacted]' });
        (result.runner as { cleanup: string }).cleanup = 'blocked'; assert.equal(execution.result.runner.cleanup, 'removed');
      } finally { await execution.retryCleanup(); await execution.release(); }
    } finally {
      if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
      await rm(root, { recursive: true, force: true });
    }
  });
