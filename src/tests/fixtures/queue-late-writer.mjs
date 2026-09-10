import { join } from 'node:path';
import { once } from 'node:events';
import { PersistentNodeQueue, SqliteRunRecordStore } from '@agentflow/integrations';
import { configuration } from './queue-workflow.mjs';
const [root] = process.argv.slice(2);
const store = await SqliteRunRecordStore.open(join(root, 'queue'));
let paused = false;
const guarded = {
    read: store.read.bind(store),
    create: store.create.bind(store),
    compareAndSwap: store.compareAndSwap.bind(store),
    async commitRecords(checks, writes) {
        // Pause AFTER the queue's ownership read, immediately BEFORE the actual store transaction.
        if (!paused && writes.some(row => row.runId.startsWith('run-'))) {
            paused = true;
            const resume = once(process, 'message');
            process.send({ event: 'before-commit' });
            await resume;
        }
        return store.commitRecords(checks, writes);
    },
};
try {
    const queue = new PersistentNodeQueue(guarded, configuration);
    const claim = await queue.claim('old', ['json'], 300);
    const row = await queue.records().read('a');
    try {
        await queue.bind(claim).compareAndSwap('a', row.revision, row.content);
        process.send({ event: 'unexpected-commit' });
        process.exitCode = 1;
    }
    catch (error) {
        process.send({ event: 'rejected', code: error.code }, () => process.disconnect());
    }
}
finally {
    store.close();
}
