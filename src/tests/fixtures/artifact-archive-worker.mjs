import fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const [root, source, mode, serialized] = process.argv.slice(2);
if (mode === 'before-publish' || mode === 'after-publish') {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (basename(from).startsWith('.publish-') && /^[a-f0-9-]{36}$/.test(basename(to))) {
      const text = await fs.readFile(join(from, 'manifest.json'));
      const reference = { id: basename(to), sha256: createHash('sha256').update(text).digest('hex') };
      if (mode === 'after-publish') await rename(from, to);
      process.send({ reference }, () => process.kill(process.pid, 'SIGKILL'));
      await new Promise(() => {});
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
const { ContractRegistry, FileContractRegistry } = await import('../../packages/engine/dist/index.js');
const { FileArtifactArchive, SqliteRunRecordStore } = await import('../../packages/integrations/dist/index.js');
const contracts = new FileContractRegistry(new ContractRegistry());
contracts.register('files', { rules: [{ id: 'bundle', kind: 'tree', match: 'bundle', minCount: 1, maxCount: 1, minFiles: 1, maxFiles: 5, maxBytes: 4096, mediaTypes: ['text/plain'] }], maxFiles: 5, maxTotalBytes: 4096, unmatched: 'reject' });
const archive = new FileArtifactArchive(root, contracts);
if (mode === 'restore-run') {
  const records = await SqliteRunRecordStore.open(source);
  try {
    const run = await records.read('run');
    await archive.materialize(run.content.output, serialized);
    process.send({ text: await fs.readFile(join(serialized, 'bundle/nested/answer.txt'), 'utf8') });
  } finally { records.close(); }
} else {
  const saved = await archive.capture(source, 'files'); process.send(saved);
}
process.disconnect();
