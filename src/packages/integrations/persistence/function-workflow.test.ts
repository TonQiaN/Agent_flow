import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SqliteRunRecordStore } from './sqlite-store.js';
const worker = fileURLToPath(new URL('../../../tests/fixtures/function-workflow.mjs',import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}) { const root=await mkdtemp(join(tmpdir(),'af-function-workflow-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
function child(root:string,mode:string,variant='same') {
 const process=fork(worker,[root,mode,variant],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let stderr='';process.stderr!.on('data',b=>{stderr+=b;});
 const exited=once(process,'exit'); const message=()=>Promise.race([once(process,'message').then(([m])=>m),exited.then(([code,signal])=>{throw new Error(`${code}/${signal} ${stderr}`);})]);
 return {process,exited,message};
}
async function complete(root:string,mode:string,variant='same') { const p=child(root,mode,variant);const result=await p.message();assert.deepEqual(await p.exited,[0,null]);return result; }
async function record(root:string) {const store=await SqliteRunRecordStore.open(join(root,'runs'));try{return await store.read('run');}finally{store.close();}}
async function crash(root:string,point:string) {const p=child(root,point);assert.equal((await p.message()).point,point);assert.deepEqual(await p.exited,[null,'SIGKILL']);}
for(const point of ['before-call','after-call']) test(`actual deterministic JSON Workflow resumes B after ${point} SIGKILL without rerunning accepted Gate`,{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,point);const prior=await record(root);
 assert.equal((prior!.content as any).snapshot.steps.length,1);
 const result=await complete(root,'recover');assert.equal(result.error,undefined);assert.equal(result.result.status,'succeeded');assert.equal(result.result.lastAccepted.result.output,5);
 assert.deepEqual(result.calls.map((c:any)=>[c.component,c.identity.nodeTaskId,c.identity.attemptNumber]),[['b','task-2',2]]);
 assert.deepEqual(result.result.steps[0],(prior!.content as any).snapshot.steps[0]);
 assert.deepEqual(result.record.content.attempts.map((a:any)=>a.interrupted),[false,true,false]);
 const loaded=await complete(root,'load');assert.equal(loaded.error,undefined);assert.deepEqual(loaded.calls,[]);
});
test('function implementation revision and actual config drift reject recovery before writes or invocation',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-call');const prior=await record(root);
 for(const variant of ['revision','config']){const result=await complete(root,'recover',variant);assert.equal(result.error,'WORKFLOW_EXECUTION_MISMATCH');assert.deepEqual(result.calls,[]);assert.deepEqual(await record(root),prior);}
});
test('late original pure computation cannot overwrite recovered Run state',{timeout:15000},async t=>{
 const root=await fixture(t),old=child(root,'hold-after-call');t.after(()=>{old.process.kill();});assert.equal((await old.message()).point,'after-call');
 assert.equal((await complete(root,'recover')).result.status,'succeeded');const saved=await record(root);
 const result=old.message();old.process.send('continue');assert.equal((await result).error,'RUN_REVISION_CONFLICT');assert.deepEqual(await old.exited,[0,null]);assert.deepEqual(await record(root),saved);
});
test('two function recoverers use existing Run CAS so only one executes a new Attempt',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-call');const peers=[child(root,'recover-compete'),child(root,'recover-compete')];t.after(()=>{for(const p of peers)p.process.kill();});
 await Promise.all(peers.map(async p=>assert.equal((await p.message()).point,'read')));const next=peers.map(p=>p.message());for(const p of peers)p.process.send('continue');const results=await Promise.all(next);
 await Promise.all(peers.map(async p=>assert.deepEqual(await p.exited,[0,null])));assert.equal(results.filter(r=>r.result?.status==='succeeded').length,1);assert.equal(results.filter(r=>r.error==='RUN_REVISION_CONFLICT').length,1);assert.equal(results.flatMap(r=>r.calls).length,1);
});

test('repeated function host crashes retain every Attempt and do not consume additional workflow steps',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'before-call');
 const middle=child(root,'recover-after-call');assert.equal((await middle.message()).point,'after-call');assert.deepEqual(await middle.exited,[null,'SIGKILL']);
 const result=await complete(root,'recover');assert.equal(result.result.status,'succeeded');assert.equal(result.result.steps.length,2);assert.equal(result.result.lastAccepted.result.output,5);
 assert.deepEqual(result.calls.map((c:any)=>[c.component,c.identity.nodeTaskId,c.identity.attemptNumber]),[['b','task-2',3]]);
 assert.deepEqual(result.record.content.attempts.map((a:any)=>a.interrupted),[false,true,true,false]);
});
