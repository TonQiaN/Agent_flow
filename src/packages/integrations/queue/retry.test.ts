import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeWorker,loadWorkflowCheckpoint,claimWorkflowRecovery,decideRetry,validateRetryPolicy } from '@agentflow/engine';
import { SqliteRunRecordStore } from '../persistence/sqlite-store.js';
import { PersistentNodeQueue } from './node-queue.js';
import { systemClock } from '../system-clock.js';
// @ts-expect-error Shared source fixture for process restart tests.
import { application, configuration, policy } from '../../../tests/fixtures/retry-workflow.mjs';
async function setup(t: {after(fn:()=>Promise<void>):void}) {
 const root=await mkdtemp(join(tmpdir(),'af-retry-'));let store=await SqliteRunRecordStore.open(join(root,'db')),now=1000;
 const clock={now:()=>now,sleep:systemClock.sleep};let queue=new PersistentNodeQueue(store,configuration,clock);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return {clock,queue:()=>queue,advance:(ms=1000)=>now+=ms,async reopen(){store.close();store=await SqliteRunRecordStore.open(join(root,'db'));queue=new PersistentNodeQueue(store,configuration,clock);},
 async submit(id:string,options={}){const a=application({clock,...options});await a.runtime.preparePersisted(a.compiled,id,{original:1},queue.records());},
 worker(options={}){return new NodeWorker(queue,{open:async()=>application({clock,...options})},clock,'worker',['json'],300);},
 async load(id:string,options={}){const r=await loadWorkflowCheckpoint(application({clock,...options}).compiled,id,queue.records());const c=r.checkpoint;await r.dispose();return c;}};
}
test('retry policy validates finite budgets and matches only explicit safe failure facts',()=>{
 for(const x of [null,{...policy,maxAttempts:0},{...policy,maxAttempts:1.5},{...policy,delayMs:-1},{...policy,on:['text']},{...policy,on:['timeout','timeout']},{...policy,extra:true}])assert.throws(()=>validateRetryPolicy(x));
 for(const code of ['INVALID_NODE_OUTPUT','AUTHENTICATION_REQUIRED','EFFECT_RESULT_UNKNOWN','CANCEL_REQUESTED','please retry timeout'])assert.equal(decideRetry(policy,1,code,true,false,100),null);
 assert.equal(decideRetry(undefined,1,'EXECUTION_TIMEOUT',true,false,100),null);
 assert.equal(decideRetry(policy,3,'EXECUTION_TIMEOUT',true,false,100),null);
 assert.equal(decideRetry(policy,1,'EXECUTION_TIMEOUT',false,false,100),null);
 assert.equal(decideRetry(policy,1,'EXECUTION_TIMEOUT',true,true,100),null);
 assert.equal(decideRetry(policy,1,'EXECUTION_TIMEOUT',true,false,100.25)!.nextAt,1100.25);
 assert.throws(()=>application().runtime.start(application().compiled,'nonpersist',{}),/RETRY_REQUIRES_PERSISTENCE/);
});
test('retry waits persist across store reopen, release role capacity and preserve task/input/budget',async t=>{
 const s=await setup(t),seen:any[]=[];
 const invoke=async(x:any)=>{seen.push(structuredClone(x.input));x.input.original=999;return x.component.id==='a'&&x.identity.attemptNumber<3?'IMPLEMENTATION_FAILED':null;};
 await s.submit('run');
 let r=await s.worker({invoke}).runOnce();assert.equal(r!.waiting,'RETRY_WAIT');assert.equal(r!.error,null);
 assert.equal(r!.snapshot!.steps.length,0);assert.equal(r!.snapshot!.retry!.nextAt,2000);
 let c=await s.load('run');assert.equal(c.attempts.length,1);assert.equal(c.attempts[0]!.retry!.result.code,'IMPLEMENTATION_FAILED');
 assert.equal((await s.queue().query())[0]!.owner,null);assert.equal(await s.worker({invoke}).runOnce(),null);
 await s.submit('other',{retry:null});assert.equal((await s.worker({retry:null,invoke:async()=>null}).runOnce())!.claim.runId,'other');
 await s.reopen();assert.equal((await s.load('run')).snapshot.retry!.nextAt,2000);
 s.advance();r=await s.worker({invoke}).runOnce();assert.equal(r!.snapshot!.retry!.attemptNumber,2);
 c=await s.load('run');assert.deepEqual(c.attempts.map(a=>a.identity.attemptNumber),[1,2]);assert.deepEqual(c.cursor.value,{original:1});
 await s.reopen();s.advance();r=await s.worker({invoke}).runOnce();assert.equal(r!.snapshot!.lastAccepted!.result.identity.attemptNumber,3);
 assert.equal(r!.snapshot!.lastAccepted!.result.identity.nodeTaskId,'task-1');
 assert.deepEqual(seen.slice(0,3),[{original:1},{original:1},{original:1}]);
});
test('waiting cancellation survives restart and never produces another attempt',async t=>{
 const s=await setup(t);await s.submit('cancel');await s.worker().runOnce();assert.equal(await s.queue().cancelReady('cancel'),true);
 await s.reopen();s.advance(10000);assert.equal(await s.worker().runOnce(),null);const c=await s.load('cancel');assert.equal(c.snapshot.status,'cancelled');assert.equal(c.attempts.length,1);assert.equal(c.snapshot.retry,undefined);
});
test('default and excluded errors do not retry; exhausted failures remain explicit',async t=>{
 const s=await setup(t);
 for(const [id,options] of [['default',{retry:null}],['contract',{invoke:async()=> 'INVALID_NODE_OUTPUT'}],['unknown',{invoke:async()=> 'EFFECT_RESULT_UNKNOWN'}]] as const){
  await s.submit(id,options);const r=await s.worker(options).runOnce();assert.equal(r!.snapshot!.status,'failed');assert.equal(r!.snapshot!.retry,undefined);assert.equal((await s.load(id,options)).attempts.length,1);
  if(id==='unknown')assert.equal(r!.error,'WORKER_RESULT_UNCONFIRMED');
 }
});
test('tampered wait metadata and attempt retry evidence are rejected by the normal loader',async t=>{
 const s=await setup(t);await s.submit('tamper');await s.worker().runOnce();const row=(await s.queue().records().read('tamper'))!;
 for(const mutate of [(c:any)=>c.snapshot.retry.nextAt++, (c:any)=>c.attempts[0].retry.nextAt++, (c:any)=>c.attempts[0].retry.result.stopped=false,(c:any)=>c.attempts[0].identity.attemptNumber=2]){
  const content=structuredClone(row.content);mutate(content);
  await assert.rejects(loadWorkflowCheckpoint(application().compiled,'tamper',{read:async()=>({...row,content})}),/INVALID_WORKFLOW_CHECKPOINT/);
 }
});

test('early direct recovery cannot run and duplicate old queue writers cannot reschedule a retry',async t=>{
 const s=await setup(t);await s.submit('due');const first=await s.worker().runOnce();const row=(await s.queue().records().read('due'))!;
 await assert.rejects(s.queue().bind(first!.claim).compareAndSwap('due',row.revision,row.content),/QUEUE_CLAIM_LOST/);
 // A separate unqueued copy checks the runtime deadline independently of queue admission.
 const memory={...structuredClone(row)},records={read:async()=>structuredClone(memory),create:async()=>{throw new Error();},compareAndSwap:async(_id:string,revision:number,content:any)=>{assert.equal(revision,memory.revision);memory.revision++;memory.content=structuredClone(content);return structuredClone(memory);}};
 const app=application({clock:s.clock}),recovery=await claimWorkflowRecovery(app.compiled,'due',records);await recovery.cleanup();
 await assert.rejects(app.runtime.resumePersisted(recovery),/RETRY_NOT_DUE/);assert.equal((memory.content as any).checkpoint.attempts.length,1);await recovery.dispose();
});

test('heartbeat racing a completed retry wait does not cancel it after ownership is released',async t=>{
 const s=await setup(t);await s.submit('heartbeat');let releaseExecution!:()=>void,releaseRead!:()=>void,readStarted!:()=>void;
 const executing=new Promise<void>(r=>releaseExecution=r),heldRead=new Promise<void>(r=>releaseRead=r),reading=new Promise<void>(r=>readStarted=r);
 const queue=s.queue(),original=queue.cancellationRequested.bind(queue);let reads=0;
 queue.cancellationRequested=async claim=>{if(++reads===2){readStarted();await heldRead;}return original(claim);};
 const running=s.worker({invoke:async()=>{await executing;return 'IMPLEMENTATION_FAILED';}}).runOnce();await reading;releaseExecution();
 for(let i=0;i<100&&(await queue.query())[0]!.state!=='ready';i++)await new Promise(r=>setTimeout(r,2));
 assert.equal((await queue.query())[0]!.state,'ready');releaseRead();const result=await running;assert.equal(result!.error,null);assert.equal(result!.waiting,'RETRY_WAIT');assert.equal((await s.load('heartbeat')).snapshot.cancelRequested,false);
});
