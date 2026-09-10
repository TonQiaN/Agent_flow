import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CodexSubscriptionRunner, CodexSubscriptionCodec, FileCredentialStore, CodexAgentDriver, FileArtifactStore } from '@agentflow/integrations';
import { AgentExecutor, ContractRegistry, FileContractRegistry } from '@agentflow/engine';

// This executable only simulates the protocol. It never calls an auth service or a model.
const executable = `#!/usr/bin/env node
const fs=require('fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}
const path=process.env.CODEX_HOME+'/auth.json',auth=JSON.parse(fs.readFileSync(path,'utf8'));
const original=auth.tokens.access_token;auth.tokens.access_token='fixture-access-refreshed';fs.writeFileSync(path,JSON.stringify(auth));
const input='/task/input/numbers.json',numbers=JSON.parse(fs.readFileSync(input,'utf8')).numbers;
fs.appendFileSync(input,'\\n');fs.writeFileSync('/task/outputs/answer.json',JSON.stringify({sum:numbers.reduce((a,b)=>a+b,0)}));
const schema=process.argv.indexOf('--output-schema');
const message=schema<0?original+' '+auth.tokens.access_token:JSON.stringify({outcome:JSON.parse(fs.readFileSync(process.argv[schema+1],'utf8')).properties.outcome.enum.at(-1)});
for(const event of [{type:'thread.started',thread_id:'fixture-thread'},{type:'turn.started'},
 {type:'item.completed',item:{id:'message',type:'agent_message',text:message}},
 {type:'turn.completed',usage:{input_tokens:3,output_tokens:1}}])console.log(JSON.stringify(event));
`;
test('Codex composition: synthetic executable exercises version, binding, refresh, redaction and output handoff without model calls',
  { skip: process.env['AGENTFLOW_EGRESS_TESTS'] !== '1', timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-codex-composition-')); const tag = `agentflow-test/codex-fixture:${randomUUID()}`;
    let built = false; const executionTag = `${tag}-execution`, proxyTag = `${tag}-proxy`; let aliases = false;
    try {
      const build = join(root, 'build'); await mkdir(build);
      await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex /usr/local/bin/codex\n');
      await writeFile(join(build, 'codex'), executable);
      execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', tag, build], { stdio: 'pipe', timeout: 60_000 }); built = true;
      const input = join(root, 'input'); await mkdir(input); const original = '{"numbers":[1,2,3]}\n'; await writeFile(join(input, 'numbers.json'), original);
      const credential = { credentialRef: 'fixture', service: 'openai', method: 'subscription' };
      const store = new FileCredentialStore(join(root, 'store'), [new CodexSubscriptionCodec()]);
      await store.configure(credential, { content: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'fixture-id-original', access_token: 'fixture-access-original', refresh_token: 'fixture-refresh-original', account_id: 'fixture-account' } }) });
      execFileSync('docker', ['tag', tag, executionTag]); execFileSync('docker', ['tag', 'node:22-bookworm-slim', proxyTag]); aliases = true;
      const runtime = new CodexSubscriptionRunner(store, { workspaceRoot: join(root, 'attempts'), image: executionTag, proxyImage: proxyTag });
      const definitionTask = { identity: { runId: 'definition', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
        prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false } };
      const profile = { id: 'test', ...credential, service: 'openai' as const, method: 'subscription' as const, endpoint: 'official' as const, capacity: 1 as const };
      const held = await store.acquire(credential);
      let definition: any;
      try { definition = await runtime.definitionSnapshot(definitionTask, profile, 10000); }
      finally { await held.release(); }
      // Repoint only this test's aliases: execution and its proxy must consume the pinned IDs.
      execFileSync('docker', ['tag', 'node:22-bookworm-slim', executionTag]); execFileSync('docker', ['tag', 'alpine:3', proxyTag]);
      const probeEvents: string[] = []; let probeCheckpoint: any;
      const execution = await runtime.run({ task: { identity: { runId: 'composition', nodeTaskId: 'task', attemptId: 'first', attemptNumber: 1 },
        prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false } },
      profile: { id: 'test', ...credential, service: 'openai', method: 'subscription', endpoint: 'official', capacity: 1 }, inputSource: input, timeoutMs: 10_000 }, undefined, { version: {
        async save(record) { probeCheckpoint = record; probeEvents.push('allocated'); },
        async launch(state) { probeEvents.push(state); },
        async complete() {
          assert.equal(execFileSync('docker', ['container', 'ls', '--all', '--filter', `name=^/${probeCheckpoint.runner.resource.id}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim(), '');
          probeEvents.push('complete');
        },
      } });
      assert.deepEqual(probeEvents, ['allocated', 'prepare_pending', 'prepare_completed', 'create_pending', 'create_completed', 'start_pending', 'start_completed', 'complete']);
      assert.deepEqual(probeCheckpoint.definition, definition.versionProbe);
      try {
        const result = execution.result;
        assert.equal(result.stage, 'execution'); assert.equal(result.harness?.status, 'completed'); assert.equal(result.harness?.outcome, null);
        assert.equal(result.authentication?.refresh, 'updated'); assert.equal(result.authentication?.credential?.revision, 2); assert.deepEqual(result.diagnostics, []);
        assert.equal(result.runner.capture!.imageId, definition.environment.options.image);
        assert.equal(result.runner.capture!.network!.proxyImageId, definition.environment.options.network.proxyImage);
        assert.deepEqual(await runtime.definitionSnapshot(definitionTask, profile, 10000), definition);
        assert.equal(result.runner.capture!.imageId, result.version.imageId); assert.equal(result.version.actual, '0.153.4');
        assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
        assert.deepEqual(JSON.parse(await readFile(join(result.runner.capture!.outputsPath, 'answer.json'), 'utf8')), { sum: 6 });
        assert.ok(!JSON.stringify(result).includes('fixture-access-'));
        const message = result.harness!.events.find(event => event.kind === 'message'); assert.deepEqual(message!.data, { itemType: 'agent_message', text: '[redacted] [redacted]' });
        (result.runner as { cleanup: string }).cleanup = 'blocked'; assert.equal(execution.result.runner.cleanup, 'removed');
      } finally { await execution.retryCleanup(); await execution.release(); }
      const json = new ContractRegistry();
      json.register('input', { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'], additionalProperties: false });
      json.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
      const files = new FileContractRegistry(json);
      for (const [id, path, schema] of [['input', 'numbers.json', 'input'], ['answer', 'answer.json', 'answer']] as const) files.register(id, {
        rules: [{ id, kind: 'file', match: path, minCount: 1, maxCount: 1, mediaTypes: ['application/json'], maxBytes: 1024, jsonContract: schema }],
        maxFiles: 1, maxTotalBytes: 1024, unmatched: 'reject',
      });
      const artifacts = new FileArtifactStore(join(root, 'artifacts'), files);
      const driver = new CodexAgentDriver(runtime, artifacts, { id: 'test', ...credential, service: 'openai', method: 'subscription', endpoint: 'official', capacity: 1 },
        { timeoutMs: 10_000 });
      const coordinator = new AgentExecutor(files, artifacts, driver);
      for (const multi of [false, true]) {
        const attempt = await coordinator.execute({ componentId: 'sum', identity: { runId: 'coordinated', nodeTaskId: 'sum', attemptId: multi ? 'multi' : 'single', attemptNumber: 1 },
          prompt: 'synthetic protocol wiring', config: { model: 'fixture-model', subagents: false, search: false }, input: { source: input, contractId: 'input' },
          outcomes: multi ? { accepted: 'answer', rejected: 'answer' } : { completed: 'answer' } });
        try {
          const result = attempt.result; assert.equal(result.status, 'accepted'); if (result.status !== 'accepted') throw new Error('NOT_ACCEPTED');
          assert.equal(result.receipt.outcome, multi ? 'rejected' : 'completed'); assert.equal(result.receipt.version, '0.153.4');
          assert.equal(result.receipt.input.contractId, 'input'); assert.equal(result.receipt.output.contractId, 'answer');
          assert.ok(!JSON.stringify(attempt).includes('fixture-access')); assert.ok(!JSON.stringify(attempt).includes(root));
          const target = join(root, multi ? 'multi-result' : 'single-result'); await artifacts.materialize(result.receipt.output.id, target);
          assert.deepEqual(JSON.parse(await readFile(join(target, 'answer.json'), 'utf8')), { sum: 6 });
          assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
          await coordinator.releaseOutput(result.receipt.id);
        } finally { await attempt.retryCleanup(); await attempt.releaseExecution(); }
      }
      await assert.rejects(readdir(join(root, 'driver-inputs')), { code: 'ENOENT' }); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
    } finally {
      if (aliases) execFileSync('docker', ['image', 'rm', executionTag, proxyTag], { stdio: 'pipe' });
      if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
      await rm(root, { recursive: true, force: true });
    }
  });
