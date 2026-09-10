import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {NodeWorker,loadWorkflowCheckpoint} from '@agentflow/engine';
import {systemClock} from '../system-clock.js';
import {SqliteRunRecordStore} from '../persistence/sqlite-store.js';
import {PersistentNodeQueue} from './node-queue.js';
// @ts-expect-error Shared executable source fixture.
import {application} from '../../../tests/fixtures/parallel-workflow.mjs';
function child(root:string,operation:string,worker=operation){const p=fork(new URL('../../../tests/fixtures/parallel-worker.mjs',import.meta.url),[root,operation,worker],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let stderr='';p.stderr!.on('data',b=>stderr+=b);p.stdout!.resume();const messages:any[]=[];p.on('message',m=>messages.push(m));const timeout=setTimeout(()=>p.kill('SIGKILL'),10000),exited=once(p,'exit').finally(()=>clearTimeout(timeout));
 const next=async()=>{for(;;){if(messages.length)return messages.shift();await Promise.race([once(p,'message'),exited.then(()=>{if(!messages.length)throw new Error(stderr||'early exit');})]);}};return{p,next,exited};}
async function complete(root:string,operation:string){const c=child(root,operation),result=await c.next();assert.deepEqual(await c.exited,[0,null],JSON.stringify(result));return result;}
async function fixture(t:{after(fn:()=>Promise<void>):void}){const root=await mkdtemp(join(tmpdir(),'af-parallel-process-'));t.after(()=>rm(root,{recursive:true,force:true}));await complete(root,'prepare');return root;}
async function finish(root:string){let last:any;for(let n=0;n<12;n++){const current=await complete(root,'once');assert.equal(current.result?.error??null,null,JSON.stringify(current.result));if(!current.result)return last;last=current;}throw new Error('PARALLEL_DID_NOT_FINISH');}
for(const stage of ['expanded','child'])test(`actual process SIGKILL after ${stage} preserves successful units and stable expansion`,{timeout:20000},async t=>{
 const root=await fixture(t);if(stage==='child'){await complete(root,'once');await complete(root,'once');}
 const old=child(root,stage==='expanded'?'hold-expand':'hold');t.after(async()=>{if(old.p.exitCode===null&&old.p.signalCode===null)old.p.kill('SIGKILL');await old.exited;});const point=await old.next();assert.equal(point.event,stage==='expanded'?'expanded':'executing');if(stage==='child')assert.equal(point.id,'b');
 old.p.kill('SIGKILL');assert.deepEqual(await old.exited,[null,'SIGKILL']);await new Promise(r=>setTimeout(r,1000));const final=await finish(root);assert.equal(final.result.snapshot.status,'succeeded');
 const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(calls.filter(c=>c.id==='a').length,1);assert.equal(calls.filter(c=>c.id==='c').length,1);assert.equal(calls.filter(c=>c.component==='finish').length,1);
 assert.equal(final.record.content.attempts.filter((a:any)=>a.parallel).length,1);assert.deepEqual(final.result.snapshot.lastAccepted.result.output.items.map((c:any)=>c.id),['a','b','c']);
 if(stage==='child'){assert.deepEqual(calls.filter(c=>c.id==='b').map(c=>c.identity.attemptNumber),[1,2]);const parent=final.record.content.attempts[0].parallel;const raw=await SqliteRunRecordStore.open(join(root,'db')),queue=new PersistentNodeQueue(raw,application().configuration);try{const row:any=await queue.records().read(parent.children[1].runId);assert.deepEqual(row.content.attempts.map((a:any)=>a.identity.attemptNumber),[1,2]);assert.equal(row.content.attempts[0].retry.result.code,'ATTEMPT_INTERRUPTED');}finally{raw.close();}}
});
test('independent real Worker processes respect the parallel node cap', {timeout:15000},async t=>{
 const root=await fixture(t);await complete(root,'once');const workers=[child(root,'hold','first'),child(root,'hold','second')];t.after(async()=>{for(const c of workers){if(c.p.exitCode===null&&c.p.signalCode===null)c.p.kill('SIGKILL');await c.exited;}});
 const running=await Promise.all(workers.map(c=>c.next()));assert.deepEqual(running.map(r=>r.id).sort(),['a','b']);const unavailable=await complete(root,'once');assert.equal(unavailable.result,null);assert.equal(unavailable.tasks.find((t:any)=>t.state==='ready').reason,'PARALLEL_CAPACITY');
 for(const c of workers)c.p.send('continue');for(const c of workers){assert.equal((await c.next()).result.error,null);assert.deepEqual(await c.exited,[0,null]);}assert.equal((await finish(root)).result.snapshot.status,'succeeded');
});

for (const competingClaim of [false, true]) test(`group cancellation after recovered credential wait preserves ownership; competing=${competingClaim}`, {timeout:20000}, async t => {
 const root=await fixture(t);await complete(root,'once');await complete(root,'once');
 const old=child(root,'hold');t.after(async()=>{if(old.p.exitCode===null&&old.p.signalCode===null)old.p.kill('SIGKILL');await old.exited;});
 const executing=await old.next();assert.equal(executing.id,'b');old.p.kill('SIGKILL');assert.deepEqual(await old.exited,[null,'SIGKILL']);
 await systemClock.sleep(1000);
 const app=application(),raw=await SqliteRunRecordStore.open(join(root,'db')),queue=new PersistentNodeQueue(raw,app.configuration);
 t.after(async()=>{raw.close();});
 const worker=new NodeWorker(queue,{open:async(...args)=>({...await app.open(...args),admission:{acquire:async()=>false,release:async()=>{}}})},systemClock,'recovery',['json'],300);
 const recovered=await worker.runOnce();assert.equal(recovered!.waiting,'CREDENTIAL_SOURCE_BUSY');
 const childId=recovered!.claim.runId,before=(await queue.records().read(childId))!.content as any;
 assert.equal(before.resourceRemoved,true);assert.equal(before.checkpoint.attempts.length,1);assert.notEqual(before.checkpoint.snapshot.currentIdentity,null);
 if(competingClaim){
  await systemClock.sleep(1100);
  const commit=raw.commitRecords.bind(raw);let reached!:()=>void,release!:()=>void;
  const paused=new Promise<void>(r=>reached=r),allowed=new Promise<void>(r=>release=r);
  raw.commitRecords=async(checks,writes)=>{if(writes.some(w=>(w.content as any).snapshot?.status==='cancelled')){reached();await allowed;}return commit(checks,writes);};
  const cancelling=queue.cancelReady('run');
  // Propagate early rejection rather than waiting forever for the transaction hook.
  await Promise.race([paused,cancelling.then(()=>{throw new Error('CANCEL_DID_NOT_REACH_TRANSACTION');})]);
  let claimed;
  try{claimed=await queue.claim('competing',['json'],30000);assert.equal(claimed!.runId,childId);}finally{release();}
  assert.equal(await cancelling,true);
  assert.deepEqual((await queue.records().read(childId))!.content,before);
  const task=(await queue.query()).find(t=>t.runId===childId)!;
  assert.equal(task.owner!.token,claimed!.token);assert.equal(task.cancelRequested,true);assert.equal(task.state,'leased');
 }else{
  const read=raw.read.bind(raw);
  raw.read=async id=>{const row=await read(id);const value=row?.content as any;
   return value?.schema==='agentflow-workflow-recovery/v1'&&value.checkpoint.snapshot.runId===childId
    ? {...row!,content:{...value,resourceRemoved:false}} : row;};
  try{await assert.rejects(queue.cancelReady('run'),/QUEUE_TASK_ACTIVE/);}finally{raw.read=read;}
  assert.deepEqual((await queue.records().read(childId))!.content,before);
  assert.equal(await queue.cancelReady('run'),true);
  const loaded=await loadWorkflowCheckpoint(app.parallel.childWorkflow(before.checkpoint.snapshot.workflowId),childId,queue.records());
  assert.equal(loaded.checkpoint.snapshot.status,'cancelled');assert.equal(loaded.checkpoint.attempts.length,1);await loaded.dispose();
  const parent=await new NodeWorker(queue,{open:app.open},systemClock,'join',['json'],300).runOnce();
  assert.equal(parent!.error,null);assert.equal(parent!.snapshot!.status,'cancelled');
  const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.deepEqual(calls.map(c=>c.id),['a','b']);assert.equal(await new NodeWorker(queue,{open:app.open},systemClock,'idle',['json'],300).runOnce(),null);
 }
});
