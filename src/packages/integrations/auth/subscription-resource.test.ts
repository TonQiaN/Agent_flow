import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FileCredentialStore } from './file-store.js';
import { SubscriptionResourceBinding } from './subscription-resource.js';
const credential = { credentialRef: 'fixture', service: 'fixture', method: 'subscription' };
const codec = { service: 'fixture', method: 'subscription', validate: (s: string) => s.startsWith('fixture-') };
const identity = { runId: 'run', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 };
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'af-subscription-owned-')), store = new FileCredentialStore(join(root, 'store'), [codec]), resource = `af-${randomUUID()}`;
 await store.configure(credential, { content: 'fixture-original' });
 return { root, store, resource, close: () => rm(root, { recursive: true, force: true }) };
}
test('source ownership survives reopening, seals stale readers and cannot roll back later configure/delete', async () => {
 const f = await fixture();try {
 const first = await f.store.acquireExecution(credential, f.resource);
 assert.equal(await first.readSecret(), 'fixture-original'); await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/);
 const reopened = new FileCredentialStore(join(f.root, 'store'), [codec]);
 await assert.rejects(reopened.finishExecution(credential, `af-${randomUUID()}`, 'fixture-wrong'), /OWNERSHIP_LOST/);
 const result = await reopened.finishExecution(credential, f.resource, 'fixture-refreshed'); assert.equal(result.refresh, 'updated'); assert.equal(result.credential?.revision, 2);
 await assert.rejects(first.readSecret(), /EXECUTION_CLOSED/); await assert.rejects(f.store.acquireExecution(credential, f.resource), /EXECUTION_CLOSED/);
 await f.store.configure(credential, { content: 'fixture-new-login' });
 assert.deepEqual(await reopened.finishExecution(credential, f.resource, 'fixture-old'), result);
 const lease = await f.store.acquire(credential);assert.equal(await lease.readSecret(), 'fixture-new-login');await lease.release();
 await f.store.delete(credential);await reopened.finishExecution(credential, f.resource, 'fixture-old');assert.equal(await f.store.inspect(credential), null);
 }finally{await f.close();}
});
test('recovery before acquisition seals the resource, invalid refresh preserves source, unknown locks stay locked', async () => {
 const f = await fixture();try {
 assert.equal((await f.store.finishExecution(credential, f.resource, null)).refresh, 'not_prepared');
 await assert.rejects(f.store.acquireExecution(credential, f.resource), /EXECUTION_CLOSED/);
 const other = `af-${randomUUID()}`;await f.store.acquireExecution(credential, other);
 assert.equal((await f.store.finishExecution(credential, other, 'bad')).refresh, 'failed');assert.equal((await f.store.inspect(credential))!.revision, 1);
 const held = await f.store.acquire(credential);await assert.rejects(f.store.finishExecution(credential, `af-${randomUUID()}`, null), /OWNERSHIP_UNKNOWN/);
 await assert.rejects(f.store.acquire(credential), /CREDENTIAL_BUSY/);await held.release();
 await mkdir(join(f.root, 'store/.fixture.execution-operation.lock'));await assert.rejects(f.store.acquireExecution(credential, `af-${randomUUID()}`), /OPERATION_BUSY/);
 }finally{await f.close();}
});
test('restored binding reads nothing until stopped-resource release and commits the private copy once', async () => {
 const f = await fixture();try {
 const state = join(f.root, 'state');await mkdir(state, {mode:0o700});
 const binding = new SubscriptionResourceBinding(f.store, credential, 'harness/auth.json', {HARNESS_HOME:'/task/state/harness'}, identity);
 await binding.prepare({id:f.resource}, state);await writeFile(join(state, 'harness/auth.json'), 'fixture-refreshed');
 let calls=0;const source={executionDefinition:f.store.executionDefinition.bind(f.store),acquireExecution:async()=>{throw new Error('NO_ACQUIRE');},finishExecution:async(...args: Parameters<typeof f.store.finishExecution>)=>{calls++;return f.store.finishExecution(...args);}};
 const restored = new SubscriptionResourceBinding(source, credential, 'harness/auth.json', {HARNESS_HOME:'/task/state/harness'});
 assert.deepEqual(restored.resourceDefinition(), binding.resourceDefinition());await restored.restoreResource({id:f.resource},state);assert.equal(calls,0);
 await assert.rejects(restored.prepare({id:f.resource},state),/CANNOT_EXECUTE/);
 await restored.beforeRelease({id:f.resource});assert.equal(calls,1);assert.equal((await f.store.inspect(credential))!.revision,2);
 await assert.rejects(readFile(join(state,'harness/auth.json')),{code:'ENOENT'});await restored.beforeRelease({id:f.resource});assert.equal(calls,1);
 }finally{await f.close();}
});
test('normal finalization rejects unconfirmed stop and source generation/revision conflict stays blocked', async()=>{
 const f=await fixture();try{
 const state=join(f.root,'state');await mkdir(state,{mode:0o700});
 const binding=new SubscriptionResourceBinding(f.store,credential,'auth.json',{},identity);await binding.prepare({id:f.resource},state);
 const proof:any={identity,resource:{id:f.resource},stop:'unknown',cleanup:'blocked'};await assert.rejects(binding.finish(proof),/NOT_CLEANED/);
 await assert.rejects(f.store.acquire(credential),/CREDENTIAL_BUSY/);
 const path=join(f.root,'store/fixture.json'),record=JSON.parse(await readFile(path,'utf8'));record.revision++;await writeFile(path,JSON.stringify(record));
 await assert.rejects(binding.finish({...proof,stop:'confirmed',cleanup:'removed'}),/REVISION_CONFLICT/);await assert.rejects(f.store.acquire(credential),/CREDENTIAL_BUSY/);
 }finally{await f.close();}
});

test('corrupt source finalization receipts do not unlock or return unvalidated metadata', async()=>{
 const f=await fixture();try{
 await f.store.acquireExecution(credential,f.resource);
 const path=join(f.root,`store/.execution-fixture-${f.resource}.json`);
 await writeFile(path,JSON.stringify({refresh:'updated',credential:{credentialRef:'other'}}),{mode:0o600});
 await assert.rejects(f.store.finishExecution(credential,f.resource,'fixture-next'),/CORRUPT_CREDENTIAL_EXECUTION_RESULT/);
 await assert.rejects(f.store.acquire(credential),/CREDENTIAL_BUSY/);assert.equal((await f.store.inspect(credential))!.revision,1);
 }finally{await f.close();}
});
