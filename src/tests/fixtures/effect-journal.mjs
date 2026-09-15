import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { ContractRegistry, ComponentRegistry, EffectExecutor, EFFECT_RECEIPT_SCHEMA } from '@agentflow/engine';
import { SqliteEffectRecordStore } from '@agentflow/integrations';
const [root, mode, changed = 'no'] = process.argv.slice(2);
const store = await SqliteEffectRecordStore.open(join(root, 'journal'));
const stop = async point => { if (mode === point) { process.send({ point }, () => process.kill(process.pid, 'SIGKILL')); await new Promise(() => {}); } };
const journal = { identity: store.identity, read: store.read.bind(store),
  create: async (...args) => { await stop('before-reserve'); const row = await store.create(...args); await stop('reserved'); return row; },
  compareAndSwap: async (...args) => { const row = await store.compareAndSwap(...args); await stop('after-receipt'); return row; } };
const contracts = new ContractRegistry(); contracts.register('input', { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false });
for (const status of ['applied', 'already-applied', 'simulated']) contracts.register(status, { type: 'object', properties: { status: { const: status } }, required: ['status'] });
const components = new ComponentRegistry(contracts); components.register({ id: 'publish', kind: 'effect', implementation: 'publish-v1', inputContract: 'input', outcomes: { applied: 'applied', 'already-applied': 'already-applied', simulated: 'simulated' } });
const receipt = r => ({ schema: EFFECT_RECEIPT_SCHEMA, requestId: r.requestId, componentId: r.componentId, target: r.target, key: r.key, serviceIdentity: r.serviceIdentity, mode: r.mode, status: r.mode === 'apply' ? 'applied' : 'simulated', reference: 'result-1' });
const adapter = { implementation: 'publish-v1', serviceIdentity: 'simulated-target', simulate: async r => receipt(r), apply: async r => {
  const file = await open(join(root, 'external-writes.jsonl'), 'a', 0o600);
  try { await file.writeFile(JSON.stringify(r)+'\n'); await file.sync(); } finally { await file.close(); }
  await stop('after-effect'); return receipt(r);
} };
try {
 const executor = new EffectExecutor(contracts, components, adapter, journal);
 const request = { identity: { runId: 'run', nodeTaskId: 'task', attemptId: 'new-attempt', attemptNumber: 2 }, componentId: 'publish', target: 'target', key: 'operation', input: { value: changed === 'no' ? 1 : 2 }, mode: 'apply' };
 const result = await executor.execute(request, executor.authorize(request));
 process.send({ result, identity: store.identity, query: await executor.queryDurable('operation') });
} finally { store.close(); process.disconnect?.(); }
