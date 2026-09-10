import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SqliteRunRecordStore } from './sqlite-store.js';
const worker=fileURLToPath(new URL('../../../tests/fixtures/file-json-workflow.mjs',import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}) {const root=await mkdtemp(join(tmpdir(),'af-json-reopen-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'source'));await writeFile(join(root,'source','answer.json'),'{"value":7}');return root;}
function child(root:string,mode:string,variant='same') {
 const process=fork(worker,[root,mode,variant],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let stderr='';process.stderr!.on('data',b=>{stderr+=b;});const exited=once(process,'exit');
 const message=()=>Promise.race([once(process,'message').then(([m])=>m),exited.then(([code,signal])=>{throw new Error(`${code}/${signal} ${stderr}`);})]);return {process,exited,message};
}
async function complete(root:string,mode:string,variant='same') {const p=child(root,mode,variant),result=await p.message();assert.deepEqual(await p.exited,[0,null]);return result;}
async function record(root:string) {const store=await SqliteRunRecordStore.open(join(root,'runs'));try{return await store.read('run');}finally{store.close();}}
async function crash(root:string,point:string) {const p=child(root,point);assert.equal((await p.message()).point,point);assert.deepEqual(await p.exited,[null,'SIGKILL']);}
async function eraseTemporary(root:string) {for(const name of ['source','temporary','nodes','transforms'])await rm(join(root,name),{recursive:true,force:true});}
for(const point of ['before-read','after-read']) test(`JSON file projection resumes after ${point} SIGKILL with original directories deleted`,{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,point);await eraseTemporary(root);
 const result=await complete(root,'recover');assert.equal(result.error,undefined);assert.equal(result.result.status,'succeeded');assert.deepEqual(result.result.lastAccepted.result.output,{value:7});
 assert.deepEqual(result.calls.map((c:any)=>[c.component,c.identity.nodeTaskId,c.identity.attemptNumber]),[['project','task-1',2],['finish','task-2',1]]);assert.equal(result.matches,true);
 const loaded=await complete(root,'load');assert.equal(loaded.error,undefined);assert.deepEqual(loaded.calls,[]);assert.deepEqual(loaded.receipt,result.receipt);assert.equal(loaded.matches,true);assert.equal(loaded.afterDispose,false);
});
test('accepted projection restores original receipt without rerunning conversion before resuming downstream',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-accepted');const before=await record(root);await eraseTemporary(root);
 const result=await complete(root,'recover');assert.equal(result.error,undefined);assert.equal(result.result.status,'succeeded');assert.deepEqual(result.calls.map((c:any)=>c.component),['finish']);
 assert.deepEqual(result.result.steps[0],(before!.content as any).snapshot.steps[0]);assert.equal(result.matches,true);assert.equal(result.receipt.identity.attemptNumber,1);
 assert.deepEqual(result.receipt.predecessor,(before!.content as any).values[0].value);
});
test('JSON file path/limit drift and ordinary callbacks refuse persistence before recovery writes or calls',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-read');const before=await record(root);
 for(const variant of ['path','limit','ordinary']){const r=await complete(root,'recover',variant);assert.equal(r.error,variant==='ordinary'?'FILE_JSON_EXECUTION_DEFINITION_UNAVAILABLE':'WORKFLOW_EXECUTION_MISMATCH');assert.deepEqual(r.calls,[]);assert.deepEqual(await record(root),before);}
 const empty=await fixture(t);const ordinary=await complete(empty,'start','ordinary');assert.equal(ordinary.error,'FILE_JSON_EXECUTION_DEFINITION_UNAVAILABLE');assert.equal(await record(empty),null);
});
test('accepted JSON provenance rejects downgrade, rebound identity, predecessor, digest, outcome and output',{timeout:20000},async t=>{
 const root=await fixture(t);assert.equal((await complete(root,'start')).result.status,'succeeded');const original=(await record(root))!.content as any;await eraseTemporary(root);
 const variants=[(c:any)=>{c.values[1].saved={schema:'agentflow-json-value/v1',value:c.values[1].value};},
  (c:any)=>{c.values[1].saved.provenance.receipt.identity.attemptNumber++;},(c:any)=>{c.values[1].saved.provenance.receipt.predecessor={fileRef:'forged'};},
  (c:any)=>{c.values[1].saved.provenance.receipt.input.files[0].sha256='0'.repeat(64);},(c:any)=>{c.values[1].saved.provenance.receipt.outcome='other';},
  (c:any)=>{c.values[1].saved.provenance.receipt.output.value=9;}];
 for(const change of variants){const store=await SqliteRunRecordStore.open(join(root,'runs'));try{const row=(await store.read('run'))!,c=structuredClone(original);change(c);await store.compareAndSwap('run',row.revision,c);}finally{store.close();}
  const before=await record(root),r=await complete(root,'load');assert.ok(['INVALID_WORKFLOW_CHECKPOINT','INVALID_FILE_JSON_RESTORE'].includes(r.error),r.error);assert.deepEqual(r.calls,[]);assert.deepEqual(await record(root),before);
 }
});
test('late original file read cannot overwrite the recovered Run',{timeout:15000},async t=>{
 const root=await fixture(t),old=child(root,'hold-after-read');t.after(()=>{old.process.kill();});assert.equal((await old.message()).point,'after-read');
 assert.equal((await complete(root,'recover')).result.status,'succeeded');const before=await record(root),next=old.message();old.process.send('continue');assert.equal((await next).error,'RUN_REVISION_CONFLICT');assert.deepEqual(await old.exited,[0,null]);assert.deepEqual(await record(root),before);
});
test('competing file projection recoverers admit one new Attempt through the shared Run CAS',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'before-read');const peers=[child(root,'recover-compete'),child(root,'recover-compete')];t.after(()=>{for(const p of peers)p.process.kill();});
 await Promise.all(peers.map(async p=>assert.equal((await p.message()).point,'read')));const pending=peers.map(p=>p.message());for(const p of peers)p.process.send('continue');const results=await Promise.all(pending);
 await Promise.all(peers.map(async p=>assert.deepEqual(await p.exited,[0,null])));assert.equal(results.filter(r=>r.result?.status==='succeeded').length,1);assert.equal(results.filter(r=>r.error==='RUN_REVISION_CONFLICT').length,1);assert.equal(results.flatMap(r=>r.calls).filter(c=>c.component==='project').length,1);
});
test('a later loading failure rolls back an already restored conversion receipt',{timeout:15000},async t=>{
 const root=await fixture(t);assert.equal((await complete(root,'start')).result.status,'succeeded');const before=await record(root);
 const failed=await complete(root,'load','reject-final');assert.equal(failed.error,'WORKFLOW_RESTORED_CONTRACT_MISMATCH');assert.deepEqual(failed.calls,[]);assert.equal(failed.residual,false);assert.deepEqual(await record(root),before);
 assert.equal((await complete(root,'load')).matches,true);
});
