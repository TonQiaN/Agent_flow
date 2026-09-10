import { FileCredentialStore } from '@agentflow/integrations';

// Synthetic credential fixture used exclusively by the cross-process storage tests.
const store = new FileCredentialStore(process.argv[2], [{ service: 'test', method: 'subscription', validate: value => value.startsWith('fixture-') }]);
const identity = { credentialRef: 'shared', service: 'test', method: 'subscription' };
process.send({ state: 'starting' });
try {
  const lease = await store.acquire(identity, Number(process.argv[3]));
  process.send({ state: 'held', metadata: lease.metadata });
  process.on('message', async message => {
    if (message === 'release') { await lease.release(); process.exit(0); }
  });
} catch (error) {
  process.send({ state: 'failed', code: error.code });
  process.exitCode = 0;
  process.disconnect();
}
