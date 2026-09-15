import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { ContractRegistry, ComponentRegistry, EffectExecutor, EffectWorkflowCatalog, EFFECT_RECEIPT_SCHEMA, compileWorkflow, WorkflowRuntime, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { SqliteEffectRecordStore, SqliteRunRecordStore } from '@agentflow/integrations';
const [root, mode, variant = 'same'] = process.argv.slice(2);
const journal = await SqliteEffectRecordStore.open(join(root, variant === 'journal' ? 'other-journal' : 'journal'));
const records = await SqliteRunRecordStore.open(join(root, 'runs'));
let calls = [], approvals = [], paused = false, readOnce = false;
const pause = async point => {
 if (paused || ![point, `hold-${point}`].includes(mode)) return; paused = true;
 if (mode.startsWith('hold-')) { process.send({ point }); await new Promise(resolve => process.once('message', resolve)); }
 else { process.send({ point }, () => process.kill(process.pid, 'SIGKILL')); await new Promise(() => {}); }
};
const effectsStore = { identity: journal.identity, read: journal.read.bind(journal),
 create: async (key, content) => { if (key === 'op-b') await pause('before-reserve'); const r = await journal.create(key, content); if (key === 'op-b') await pause('reserved'); return r; },
 compareAndSwap: async (key, revision, content) => { const r = await journal.compareAndSwap(key, revision, content); if (key === 'op-b') await pause('after-receipt'); return r; } };
const store = { create: records.create.bind(records), compareAndSwap: records.compareAndSwap.bind(records), read: async (...args) => {
 const row = await records.read(...args);
 if (mode === 'recover-compete' && !readOnce) { readOnce = true; process.send({ point: 'read' }); await new Promise(resolve => process.once('message', resolve)); }
 return row;
} };
const contracts = new ContractRegistry(); contracts.register('json', { type: 'object' });
for (const status of ['applied', 'already-applied', 'simulated']) contracts.register(status, { type: 'object', properties: { status: { const: status } }, required: ['status'] });
const components = new ComponentRegistry(contracts);
for (const id of ['a','b']) components.register({ id, kind: 'effect', implementation: 'service-v1', inputContract: 'json', outcomes: { applied: 'json', 'already-applied': 'json', simulated: 'json' } });
const receipt = r => ({ schema: EFFECT_RECEIPT_SCHEMA, requestId: r.requestId, componentId: r.componentId, target: r.target, key: r.key, serviceIdentity: r.serviceIdentity, mode: r.mode, status: 'applied', reference: `external-${r.componentId}` });
const adapter = { implementation: 'service-v1', serviceIdentity: variant === 'identity' ? 'other-service' : 'test-service',
 definition: async () => ({ schema: 'test-effect-service/v1', version: variant === 'version' ? 2 : 1 }),
 simulate: async () => { throw new Error('NO_SIMULATE'); },
 apply: async r => { calls.push(r.componentId); const file = await open(join(root,'external.jsonl'),'a',0o600);
  try { await file.writeFile(JSON.stringify(r)+'\n'); await file.sync(); } finally { await file.close(); }
  if (r.key === 'op-b') await pause('after-effect'); return receipt(r);
 } };
const executor = new EffectExecutor(contracts, components, adapter, effectsStore), catalog = new EffectWorkflowCatalog(contracts, components, executor);
for (const id of ['a','b']) catalog.register(id, { mode: 'apply', operation: { target: variant === 'target' ? 'other' : `target-${id}`, key: `op-${id}` },
 approval: request => { approvals.push(request.identity); return variant === 'no-approval' ? undefined : executor.authorize(request); } });
const flow = compileWorkflow({ id:'effects',start:'a',input:{kind:'json',id:'json'},outcomes:{done:{kind:'json',id:'json'}},maxSteps:2,
 nodes:{a:{component:'a'},b:{component:'b',...(variant==='retry'?{retry:{maxAttempts:3,on:['execution_failure','interrupted'],delayMs:0}}:{})}},routes:['a','b'].flatMap(from=>['applied','already-applied','simulated'].map(outcome=>({from,outcome,to:from==='a'?{node:'b'}:{end:'done'}}))) },catalog);
let loaded,recovery,resumed;
try {
 let result;
 if (mode === 'load') { loaded = await loadWorkflowCheckpoint(flow,'run',store); result = loaded.checkpoint.snapshot; }
 else if (mode.startsWith('recover')) { recovery=await claimWorkflowRecovery(flow,'run',store); await recovery.cleanup(); resumed=await new WorkflowRuntime().resumePersisted(recovery); result=await resumed.completion; }
 else { const run=await new WorkflowRuntime().startPersisted(flow,'run',{value:1},store); result=await run.completion; }
 process.send({ result, calls, approvals, record:await records.read('run') });
} catch (error) { process.send({ error:error.code ?? 'FAILED',calls,approvals,record:await records.read('run') }); }
finally { await resumed?.dispose(); await recovery?.dispose(); await loaded?.dispose(); records.close(); journal.close(); process.disconnect?.(); }
