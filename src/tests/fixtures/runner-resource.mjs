import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Runner } from '@agentflow/engine';
import { DockerBackend, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';
const [root, operation, stage, network] = process.argv.slice(2);
const trace = phase => { if (process.env.AGENTFLOW_CI_ARTIFACTS) process.stderr.write(JSON.stringify({ at: new Date().toISOString(), phase, operation, stage }) + '\n'); };
trace('open-store');
const store = await SqliteRunRecordStore.open(join(root, 'db'));
const identity = { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 };
const options = { workspaceRoot: `${join(root, 'attempts')}/`, image: process.env.AGENTFLOW_TEST_IMAGE ?? 'alpine:3',
  ...(network ? { network: { kind: 'connect-proxy', proxyImage: 'node:22-bookworm-slim', allowedHosts: ['example.com'] } } : {}) };
const pause = async (at, resource) => { if (stage === at) { process.send({ event: 'paused', resource, stage }); await new Promise(() => { setInterval(() => {}, 1000); }); } };
try {
  if (operation === 'run') {
    class Backend extends DockerBackend {
      async create(resource, request) { await super.create(resource, request); await pause('created', resource); }
      async start(resource) { await super.start(resource); }
      async observe(resource) {
        const observation = await super.observe(resource);
        if (observation.state === 'running') await pause('running', resource);
        if (observation.state === 'exited') await pause('exited', resource);
        return observation;
      }
    }
    const backend = new Backend(options);
    const result = await new Runner(backend, systemClock).run({ identity, inputSource: join(root, 'source'), timeoutMs: 70000,
      invocation: { argv: ['/bin/sh', '-c', stage === 'exited' ? 'exit 7' : 'sleep 60'] } }, undefined,
      { save: async checkpoint => { await store.create('run', checkpoint); await pause('allocated', checkpoint.resource); if (stage === 'save-fail') throw new Error('injected'); } });
    console.log(JSON.stringify(result)); if (result.resource && result.cleanup === 'removed') await backend.release(result.resource);
  } else {
    const before = await store.read('run'), backend = new DockerBackend(options), runner = new Runner(backend, systemClock);
    trace('restore-handles');
    const restores = await Promise.allSettled([runner.restore(before.content), runner.restore(before.content)]);
    assert.equal(restores.filter(r => r.status === 'fulfilled').length, 1);
    const handle = restores.find(r => r.status === 'fulfilled').value;
    await assert.rejects(backend.start(handle.resource), /RESTORED_EXECUTION_CANNOT_START/);
    await assert.rejects(handle.release(), /RESTORED_EXECUTION_NOT_REMOVED/);
    if (operation === 'restore-unavailable') process.env.DOCKER_HOST = `unix://${root}/missing.sock`;
    let observation, error;
    trace('query');
    try { observation = await handle.query(); } catch (e) { error = e.message; }
    trace('stop-and-remove');
    const result = await handle.stopAndRemove();
    if (result.confirmed) { assert.equal((await handle.query()).state, 'absent'); await handle.release(); }
    assert.deepEqual(await store.read('run'), before);
    console.log(JSON.stringify({ observation, error, ...result }));
  }
} finally { trace('close-store'); store.close(); process.disconnect?.(); }
