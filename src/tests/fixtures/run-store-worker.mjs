import { SqliteRunRecordStore } from '@agentflow/integrations';
import { DatabaseSync } from 'node:sqlite';
const [root, mode, value] = process.argv.slice(2);
const store = await SqliteRunRecordStore.open(root);
if (mode === 'before-commit' || mode === 'after-commit') {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'COMMIT' && mode === 'before-commit') process.kill(process.pid, 'SIGKILL');
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && mode === 'after-commit') process.kill(process.pid, 'SIGKILL');
    return result;
  };
}
process.send({ event: 'ready' });
process.once('message', async () => {
  try {
    const record = await store.compareAndSwap('run', 1, { winner: value });
    process.send({ event: 'result', status: 'saved', record });
  } catch (error) { process.send({ event: 'result', status: 'error', code: error.code }); }
  finally { store.close(); process.disconnect(); }
});
