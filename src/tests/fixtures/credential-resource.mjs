import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DeepSeekApiKeyRunner, FileCredentialStore, DeepSeekApiKeyCodec, SqliteRunRecordStore } from '@agentflow/integrations';
const [root, operation, stage, image, assetsPath] = process.argv.slice(2);
const credential = { credentialRef: 'fixture', service: 'deepseek', method: 'api-key' };
const profile = { id: 'test', ...credential, endpoint: 'official', capacity: null };
const assets = JSON.parse(await readFile(assetsPath, 'utf8'));
let credentialCalls = 0;
const source = new FileCredentialStore(join(root, 'store'), [new DeepSeekApiKeyCodec()]);
const forbidden = async () => { credentialCalls++; throw new Error('CREDENTIAL_ACCESS_FORBIDDEN'); };
const selected = operation === 'run' || operation === 'lease' ? source : { acquire: forbidden, inspect: forbidden, configure: forbidden, delete: forbidden };
const runtime = new DeepSeekApiKeyRunner(selected, { workspaceRoot: join(root, 'attempts'), image, proxyImage: 'node:22-bookworm-slim' }, assets);
const store = await SqliteRunRecordStore.open(join(root, 'db'));
const pause = async at => { if (stage === at) { process.send({ event: 'paused', at }); await new Promise(() => { setInterval(() => {}, 1000); }); } };
try {
  if (operation === 'lease') { await source.acquire(credential); await pause('lease'); }
  else if (operation === 'run') {
    let record = { version: null, versionLaunch: null, versionComplete: false, execution: null, launch: null }, revision;
    const save = async () => { revision = (revision === undefined ? await store.create('run', record) : await store.compareAndSwap('run', revision, record)).revision; };
    const result = await runtime.run({ task: { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
      prompt: stage === 'completed' ? 'normal' : 'wait', config: { model: 'deepseek-v4-flash', reasoning: 'off', subagents: false, search: false } },
      profile, inputSource: join(root, 'source'), timeoutMs: 60000 }, undefined, {
      version: { async save(checkpoint) { record.version = checkpoint; await save(); }, async launch(state) { record.versionLaunch = state; await save(); }, async complete() { record.versionComplete = true; await save(); } },
      execution: {
        async save(checkpoint) {
          if (!record.versionComplete) throw new Error('PROBE_NOT_COMPLETED');
          // Actual source lease has ended before any model execution resource is exposed.
          const lease = await source.acquire(credential); await lease.release();
          record.execution = checkpoint; record.launch = 'allocated'; await save(); await pause('allocated');
          if (stage === 'save-fail') throw new Error('EXECUTION_RECORD_REJECTED');
        },
        async launch(state) { record.launch = state; await save(); await pause(state); },
      },
    });
    if (stage === 'completed' && result.result.harness?.status !== 'completed') throw new Error('SYNTHETIC_AGENT_NOT_COMPLETED');
    await pause('completed'); const view = result.result; await result.release(); process.stdout.write(JSON.stringify({ result: view }));
  } else {
    const record = (await store.read('run')).content;
    const restored = await runtime.restoreExecutionResource(record.execution, profile);
    if (operation === 'outage') process.env.DOCKER_HOST = `unix://${join(root, 'missing.sock')}`;
    let query, error; try { query = await restored.query(); } catch (e) { error = e.message; }
    const removed = await restored.stopAndRemove(); if (removed.confirmed) await restored.release();
    process.stdout.write(JSON.stringify({ query, error, ...removed, credentialCalls }));
  }
} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
finally { store.close(); }
