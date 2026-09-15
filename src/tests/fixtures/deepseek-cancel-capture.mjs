// Trusted test bootstrap: deliver cancellation precisely while the launcher syncs its captured record.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
fs.promises.open = async (...args) => {
  const file = await open(...args);
  if (args[0] === '/task/state/deepseek-session.jsonl') {
    const sync = file.sync.bind(file);
    file.sync = async () => { process.emit('SIGTERM'); await sync(); };
  }
  return file;
};
syncBuiltinESMExports();
