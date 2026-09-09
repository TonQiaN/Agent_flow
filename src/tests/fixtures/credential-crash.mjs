import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [root, stage] = process.argv.slice(2), live = join(root, 'shared.json');
const rename = fs.promises.rename, unlink = fs.promises.unlink;
const crash = () => process.kill(process.pid, 'SIGKILL');
fs.promises.rename = async (source, destination) => {
  if (destination === live && ['replace-before-live', 'recover-before-live'].includes(stage)) crash();
  await rename(source, destination);
  if (destination === live && stage === 'replace-after-live') crash();
};
fs.promises.unlink = async path => {
  if (path === live && stage === 'delete-before-live') crash();
  await unlink(path);
  if (path === live && stage === 'delete-after-live') crash();
};
syncBuiltinESMExports();
const { FileCredentialStore } = await import('@agentflow/integrations');
const store = new FileCredentialStore(root, [{ service: 'test', method: 'subscription', validate: value => value.startsWith('fixture-') }]);
const identity = { credentialRef: 'shared', service: 'test', method: 'subscription' };
if (stage.startsWith('delete')) await store.delete(identity);
else if (stage.startsWith('recover')) await store.recover(identity);
else await store.configure(identity, { content: 'fixture-new-credential' });
throw new Error('CRASH_POINT_NOT_REACHED');
