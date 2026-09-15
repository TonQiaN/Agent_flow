import { join } from 'node:path';
import { NodeWorker } from '@agentflow/engine';
import { SqliteRunRecordStore, PersistentNodeQueue, systemClock } from '@agentflow/integrations';
import { application, configuration } from './queue-workflow.mjs';
const [root, mode, worker, roleCapacity = '2'] = process.argv.slice(2);
configuration.roles.producer = Number(roleCapacity);
const store = await SqliteRunRecordStore.open(join(root, 'queue')), queue = new PersistentNodeQueue(store, configuration);
try {
    const host = { open: async (runId, records) => {
            const row = await records.read(runId), c = row.content.checkpoint ?? row.content;
            return application(c.snapshot.workflowId, async ({ component, identity }) => {
                process.send({ event: 'executing', component, identity });
                if (mode === 'hold')
                    await new Promise(resolve => process.once('message', resolve));
            });
        } };
    const w = new NodeWorker(queue, host, systemClock, worker, ['json'], 1500);
    const result = await w.runOnce();
    process.send({ event: 'done', result }, () => process.disconnect());
}
catch (error) {
    process.send({ error: error.code ?? error.message }, () => process.disconnect());
    process.exitCode = 1;
}
finally {
    store.close();
}
