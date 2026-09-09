import { join } from 'node:path';
import { CodexSubscriptionRunner, SqliteRunRecordStore } from '@agentflow/integrations';
const [root, operation, stage, image] = process.argv.slice(2);
let credentialCalls = 0;
const forbidden = async () => { credentialCalls++; throw new Error('CREDENTIAL_ACCESS_FORBIDDEN'); };
const runtime = new CodexSubscriptionRunner({ acquire: forbidden, inspect: forbidden, configure: forbidden, delete: forbidden },
  { workspaceRoot: join(root, 'attempts'), image, proxyImage: 'node:22-bookworm-slim' });
const store = await SqliteRunRecordStore.open(join(root, 'db'));
const pause = async at => { if (stage === at) { process.send({ event: 'paused', at, credentialCalls }); await new Promise(() => { setInterval(() => {}, 1000); }); } };
try {
  if (operation === 'run') {
    let record, revision;
    const save = async () => { revision = (await store.compareAndSwap('run', revision, record)).revision; };
    const execution = await runtime.run({ task: { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
      prompt: 'synthetic probe', config: { model: 'fixture-model', subagents: false, search: false } },
      profile: { id: 'test', service: 'openai', method: 'subscription', credentialRef: 'fixture', endpoint: 'official', capacity: 1 },
      inputSource: join(root, 'unused-input'), timeoutMs: 10000 }, undefined, { version: {
      async save(checkpoint) { record = { checkpoint, launch: 'allocated', complete: false }; revision = (await store.create('run', record)).revision; await pause('allocated'); if (stage === 'save-fail') throw new Error('WRITE_REJECTED'); },
      async launch(state) { record.launch = state; await save(); await pause(state); if (stage === 'launch-fail' && state === 'create_pending') throw new Error('WRITE_REJECTED'); },
      async complete() { if (stage === 'complete') { record.complete = true; await save(); await pause('complete'); } throw new Error('COMPLETION_REJECTED'); },
    } });
    const result = execution.result; await execution.release(); process.stdout.write(JSON.stringify({ result, credentialCalls }));
  } else {
    const record = (await store.read('run')).content;
    const restored = await runtime.restoreVersionResource(record.checkpoint);
    let query, error;
    if (operation === 'outage') process.env.DOCKER_HOST = `unix://${join(root, 'missing.sock')}`;
    try { query = await restored.query(); } catch (e) { error = e.message; }
    const removed = await restored.stopAndRemove();
    if (removed.confirmed) await restored.release();
    process.stdout.write(JSON.stringify({ query, error, ...removed, credentialCalls }));
  }
} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
finally { store.close(); }
