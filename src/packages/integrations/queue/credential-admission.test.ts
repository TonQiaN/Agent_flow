import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileCredentialStore } from '../auth/file-store.js';
const identity = {credentialRef:'fixture',service:'fixture',method:'subscription'};
async function setup(t:{after(fn:()=>Promise<void>):void}) {
 const root=await mkdtemp(join(tmpdir(),'af-admission-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new FileCredentialStore(join(root,'credentials'),[{service:'fixture',method:'subscription',validate:s=>s.startsWith('fixture-')}]);
 await store.configure(identity,{content:'fixture-original'});return store;
}
test('source admission waits for management, transfers ownership without an unlocked interval, then refreshes normally',async t=>{
 const store=await setup(t),token=randomUUID(),resource=`af-${randomUUID()}`;
 const management=await store.acquireManagement(identity);assert.equal(await store.acquireAdmission(identity,token),false);await management.release();
 assert.equal(await store.acquireAdmission(identity,token),true);await assert.rejects(store.acquireManagement(identity),/CREDENTIAL_BUSY/);
 const execution=await store.acquireExecution(identity,resource,token);assert.equal(await execution.readSecret(),'fixture-original');
 await assert.rejects(store.releaseAdmission(identity,token),/ADMISSION_EXECUTING/);await assert.rejects(store.acquire(identity),/CREDENTIAL_BUSY/);
 assert.equal((await store.finishExecution(identity,resource,'fixture-refreshed')).refresh,'updated');await store.releaseAdmission(identity,token);
 await assert.rejects(store.acquireAdmission(identity,token),/ADMISSION_CLOSED/);await assert.rejects(store.acquireExecution(identity,`af-${randomUUID()}`,token),/ADMISSION_CLOSED/);
 const fresh=await store.acquire(identity);assert.equal(await fresh.readSecret(),'fixture-refreshed');await fresh.release();
});
test('sealed unacquired token blocks delayed reservation; a pre-execution reservation can be recovered without touching other owners',async t=>{
 const store=await setup(t),late=randomUUID(),held=randomUUID();
 await store.releaseAdmission(identity,late);await assert.rejects(store.acquireAdmission(identity,late),/ADMISSION_CLOSED/);
 assert.equal(await store.acquireAdmission(identity,held),true);
 assert.equal((await store.finishExecution(identity,`af-${randomUUID()}`,undefined)).refresh,'not_prepared');
 await assert.rejects(store.acquireManagement(identity),/CREDENTIAL_BUSY/);await store.releaseAdmission(identity,held);
 const management=await store.acquireManagement(identity);await store.releaseAdmission(identity,held);await assert.rejects(store.acquire(identity),/CREDENTIAL_BUSY/);await management.release();
});
test('immutable admission snapshot releases the source and cannot access a later credential',async t=>{
 const store=await setup(t),token=randomUUID();await store.acquireAdmission(identity,token);const snapshot=await store.readAdmission(identity,token);
 assert.equal(await snapshot.readSecret(),'fixture-original');await snapshot.release();await store.configure(identity,{content:'fixture-rotated'});
 await assert.rejects(snapshot.readSecret(),/ADMISSION_CLOSED/);await store.releaseAdmission(identity,token);
 assert.equal((await store.inspect(identity))!.revision,2);
});
test('concurrent busy admission probes do not break the already reserved execution transfer',async t=>{
 const store=await setup(t),token=randomUUID(),resource=`af-${randomUUID()}`;assert.equal(await store.acquireAdmission(identity,token),true);
 const probes=Array.from({length:8},()=>store.acquireAdmission(identity,randomUUID()));
 const execution=await store.acquireExecution(identity,resource,token);assert.ok((await Promise.all(probes)).every(v=>v===false));
 assert.equal(await execution.readSecret(),'fixture-original');await store.finishExecution(identity,resource,'fixture-original');await store.releaseAdmission(identity,token);
});
