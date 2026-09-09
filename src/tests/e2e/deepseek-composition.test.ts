import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentExecutor, ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import { DeepSeekApiKeyRunner, DeepSeekApiKeyCodec, DeepSeekAgentDriver, FileCredentialStore, FileArtifactStore } from '@agentflow/integrations';

test('DeepSeek composition: fixed launch, snapshot, controlled egress, native evidence and Agent file acceptance with a synthetic CLI',
  { skip: process.env['AGENTFLOW_EGRESS_TESTS'] !== '1', timeout: 180000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-deepseek-composition-')), tag = `agentflow-test/deepseek-fixture:${randomUUID()}`;
    let built = false;
    try {
      const build = join(root, 'build'); await mkdir(build);
      await writeFile(join(build, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --chmod=755 dsh /usr/local/bin/dsh\nCOPY dsh-package.json /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json\n');
      await writeFile(join(build, 'dsh'), await readFile(new URL('../fixtures/deepseek-protocol.cjs', import.meta.url)));
      await writeFile(join(build, 'dsh-package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));
      execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', tag, build], { stdio: 'pipe', timeout: 60000 }); built = true;
      const input = join(root, 'input'); await mkdir(input); const original = '{"numbers":[1,2,3]}\n'; await writeFile(join(input, 'numbers.json'), original);
      const credential = { credentialRef: 'fixture', service: 'deepseek', method: 'api-key' };
      const profile = { id: 'test', ...credential, service: 'deepseek' as const, method: 'api-key' as const, endpoint: 'official' as const, capacity: null };
      const store = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
      await store.configure(credential, { content: JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-deepseek-key' }) });
      const assets = JSON.parse(execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs'], { encoding: 'utf8' }));
      const attempts = join(root, 'attempts'), runtime = new DeepSeekApiKeyRunner(store, { workspaceRoot: attempts, image: tag, proxyImage: 'node:22-bookworm-slim' }, assets);
      // Caller mutation cannot change the assets retained by the Runner.
      assets.files.find((file: any) => file.name.endsWith('/launch.mjs')).content = 'throw new Error("mutated")';
      const task = (prompt: string) => ({ identity: { runId: 'composition', nodeTaskId: 'task', attemptId: prompt, attemptNumber: 1 }, prompt,
        config: { model: 'deepseek-v4-flash', reasoning: 'off', search: false, subagents: false } });
      const phaseEvents: string[] = []; let executionRecord: any;
      for (const prompt of ['normal', 'missing-record', 'nonzero']) {
        const execution = await runtime.run({ task: task(prompt), profile, inputSource: input, timeoutMs: 15000 }, undefined, prompt === 'normal' ? {
          version: { async save() { phaseEvents.push('probe'); }, async launch() {}, async complete() { phaseEvents.push('probe-complete'); } },
          execution: { async save(record) { executionRecord = record; phaseEvents.push('execution'); const lease = await store.acquire(credential); await lease.release(); }, async launch() {} },
        } : undefined);
        try {
          const result = execution.result; assert.equal(result.stage, 'execution'); assert.equal(result.version.actual, '0.1.1-rc.2');
          assert.equal(result.runner.capture!.imageId, result.version.imageId); assert.deepEqual(result.runner.capture!.network!.allowedHosts, ['api.deepseek.com']);
          assert.equal(result.authentication?.status, 'released'); assert.equal(result.authentication?.refresh, 'unchanged');
          assert.equal((await store.inspect(credential))!.revision, 1); assert.ok(!JSON.stringify(result).includes('fixture-deepseek-key'));
          if (prompt === 'normal') {
            assert.deepEqual(phaseEvents, ['probe', 'probe-complete', 'execution']);
            assert.deepEqual(executionRecord.execution, await runtime.executionResourceDefinition(profile));
            assert.ok(!JSON.stringify(executionRecord).includes('fixture-deepseek-key'));
            assert.equal(result.harness?.status, 'completed', JSON.stringify(result)); assert.equal(result.harness.outcome, null); assert.deepEqual(result.diagnostics, []);
            const message = result.harness.events.find(event => event.kind === 'message'); assert.deepEqual(message!.data, { blockType: 'text', text: '[redacted]' });
            assert.match(await readFile(result.runner.capture!.stdout.path, 'utf8'), /proxy-denied/);
            assert.deepEqual(JSON.parse(await readFile(join(result.runner.capture!.outputsPath, 'answer.json'), 'utf8')), { sum: 6 });
          } else { assert.notEqual(result.harness?.status, 'completed'); }
          assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original);
          (result.runner as { cleanup: string }).cleanup = 'blocked'; assert.equal(execution.result.runner.cleanup, 'removed');
        } finally { await execution.retryCleanup(); await execution.release(); }
      }
      const cancelled = await runtime.run({ task: task('wait'), profile, inputSource: input, timeoutMs: 15000 }, {
        requested: () => existsSync(attempts) && readdirSync(attempts).some(id => existsSync(join(attempts, id, 'outputs/started'))),
      });
      try { assert.equal(cancelled.result.runner.phase, 'cancelled'); assert.notEqual(cancelled.result.harness?.status, 'completed'); assert.equal(cancelled.result.authentication?.status, 'released'); }
      finally { await cancelled.retryCleanup(); await cancelled.release(); }
      const json = new ContractRegistry();
      json.register('input', { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'], additionalProperties: false });
      json.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
      const files = new FileContractRegistry(json);
      for (const [id, path, schema] of [['input', 'numbers.json', 'input'], ['answer', 'answer.json', 'answer']] as const) files.register(id, {
        rules: [{ id, kind: 'file', match: path, minCount: 1, maxCount: 1, mediaTypes: ['application/json'], maxBytes: 1024, jsonContract: schema }], maxFiles: 1, maxTotalBytes: 1024, unmatched: 'reject',
      });
      const artifacts = new FileArtifactStore(join(root, 'artifacts'), files);
      const driver = new DeepSeekAgentDriver(runtime, artifacts, profile, { inputRoot: join(root, 'driver-inputs'), timeoutMs: 15000 });
      const executor = new AgentExecutor(files, artifacts, driver);
      for (const mode of ['single', 'multi', 'bad-contract']) {
        const attempt = await executor.execute({ componentId: 'sum', identity: { runId: 'coordinated', nodeTaskId: 'sum', attemptId: mode, attemptNumber: 1 }, prompt: mode,
          config: task(mode).config, input: { source: input, contractId: 'input' }, outcomes: mode === 'multi' ? { accepted: 'answer', rejected: 'answer' } : { completed: 'answer' } });
        try {
          const result = attempt.result;
          if (mode === 'bad-contract') { assert.notEqual(result.status, 'accepted'); continue; }
          assert.equal(result.status, 'accepted'); if (result.status !== 'accepted') throw new Error('NOT_ACCEPTED');
          assert.equal(result.receipt.outcome, mode === 'multi' ? 'rejected' : 'completed'); assert.equal(result.receipt.version, '0.1.1-rc.2');
          const target = join(root, mode + '-result'); await artifacts.materialize(result.receipt.output.id, target);
          assert.deepEqual(JSON.parse(await readFile(join(target, 'answer.json'), 'utf8')), { sum: 6 });
          assert.equal(await readFile(join(input, 'numbers.json'), 'utf8'), original); await executor.releaseOutput(result.receipt.id);
        } finally { await attempt.retryCleanup(); await attempt.releaseExecution(); }
      }
      assert.deepEqual(await readdir(join(root, 'driver-inputs')), []); assert.deepEqual(await readdir(join(root, 'artifacts')), []);
      // A different actual CLI version must stop before credentials are acquired or egress is opened.
      await writeFile(join(build, 'dsh-package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1' }));
      execFileSync('docker', ['build', '--network', 'none', '--pull=false', '--tag', tag, build], { stdio: 'pipe', timeout: 60000 });
      const freshRuntime = new DeepSeekApiKeyRunner(store, { workspaceRoot: attempts, image: tag, proxyImage: 'node:22-bookworm-slim' }, JSON.parse(execFileSync(process.execPath, ['src/apps/deepseek-tools/export-assets.mjs'], { encoding: 'utf8' })));
      const mismatch = await freshRuntime.run({ task: task('wrong-version'), profile: { ...profile, credentialRef: 'unconfigured' }, inputSource: input, timeoutMs: 15000 });
      try { assert.equal(mismatch.result.stage, 'version'); assert.equal(mismatch.result.authentication, null); assert.ok(mismatch.result.diagnostics.includes('HARNESS_VERSION_NOT_VERIFIED')); }
      finally { await mismatch.retryCleanup(); await mismatch.release(); }
    } finally {
      if (built) execFileSync('docker', ['image', 'rm', tag], { stdio: 'pipe' });
      await rm(root, { recursive: true, force: true });
    }
  });
