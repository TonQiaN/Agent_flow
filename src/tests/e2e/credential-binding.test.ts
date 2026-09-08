import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '@agentflow/engine';
import type { ExecutionResource, Observation } from '@agentflow/engine';
import { DockerBackend, FileCredentialStore, FileExecutionCredentialBinding, systemClock } from '@agentflow/integrations';

const enabled = process.env['AGENTFLOW_DOCKER_TESTS'] === '1';
test('Docker: credential copy refresh is finalized after nonzero, cancelled and timed-out executions before workspace release', { skip: !enabled, timeout: 30_000 }, async () => {
  for (const mode of ['nonzero', 'cancel', 'timeout'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'af-binding-docker-')); const input = join(root, 'input'); await mkdir(input);
    const identity = { runId: 'binding', nodeTaskId: 'task', attemptId: mode, attemptNumber: 1 };
    const credential = { credentialRef: 'synthetic', service: 'fixture', method: 'subscription' };
    const store = new FileCredentialStore(join(root, 'store'), [{ service: 'fixture', method: 'subscription', validate: s => s.startsWith('fixture-') }]);
    await store.configure(credential, { content: 'fixture-original' });
    const binding = await FileExecutionCredentialBinding.acquire(store, { identity, credential, stateFile: 'harness/auth.json', environment: { HARNESS_HOME: '/task/state/harness' } });
    let stateDirectory = ''; let ready = false;
    class ObservedBackend extends DockerBackend {
      override async observe(resource: ExecutionResource): Promise<Observation> {
        const observation = await super.observe(resource);
        if (observation.state === 'running') {
          try { ready = await readFile(join(stateDirectory, '../outputs/ready'), 'utf8') === 'ready'; } catch { /* Executable has not written readiness yet. */ }
        }
        return observation;
      }
    }
    const backend = new ObservedBackend({ workspaceRoot: join(root, 'attempts'), image: 'alpine:3' }, {
      environment: binding.environment,
      prepare: async (resource, directory) => { stateDirectory = directory; await binding.prepare(resource, directory); },
      beforeRelease: resource => binding.beforeRelease(resource),
    });
    const runner = new Runner(backend, systemClock);
    // A trusted executable simulates its own credential refresh. No real provider or model is involved.
    const script = 'test -f "$HARNESS_HOME/auth.json" || exit 2; printf fixture-refreshed > "$HARNESS_HOME/auth.json"; printf ready > /task/outputs/ready; '
      + (mode === 'nonzero' ? 'exit 7' : 'sleep 30');
    const run = await runner.run({ identity, inputSource: input, timeoutMs: mode === 'timeout' ? 3000 : 10_000, invocation: { argv: ['sh', '-c', script] } },
      { requested: () => mode === 'cancel' && ready });
    try {
      assert.equal(run.phase, mode === 'nonzero' ? 'exited' : mode === 'cancel' ? 'cancelled' : 'timed_out');
      assert.equal(run.exitCode, mode === 'nonzero' ? 7 : null);
      assert.equal(run.stop, 'confirmed'); assert.equal(run.cleanup, 'removed');
      assert.equal(await readFile(join(run.capture!.outputsPath, 'ready'), 'utf8'), 'ready');
      assert.equal((await store.inspect(credential))!.revision, 1);
      await assert.rejects(runner.release(run.resource!), /BINDING_NOT_FINALIZED/);
      await assert.rejects(store.acquire(credential), /CREDENTIAL_BUSY/);
      const final = await binding.finish(run);
      assert.equal(final.status, 'released'); assert.equal(final.refresh, 'updated'); assert.equal(final.credential.revision, 2);
      const lease = await store.acquire(credential); assert.equal(await lease.readSecret(), 'fixture-refreshed'); await lease.release();
      const raw = await readFile(run.capture!.stdout.path, 'utf8'); assert.equal(raw, '');
      assert.ok(!JSON.stringify({ run, final, binding }).includes('fixture-refreshed'));
      await runner.release(run.resource!);
    } finally {
      let cleaned = run;
      if (run.resource && run.cleanup !== 'removed') {
        assert.equal((await backend.stop(run.resource)).confirmed, true); await backend.remove(run.resource);
        cleaned = { ...run, stop: 'confirmed', cleanup: 'removed' };
      }
      await binding.finish(cleaned);
      if (run.resource) await runner.release(run.resource);
      await rm(root, { recursive: true, force: true });
    }
  }
});
