import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeWorker,loadWorkflowCheckpoint,RunStoreError} from '@agentflow/engine';
import {SqliteRunRecordStore} from '../persistence/sqlite-store.js';
import {PersistentNodeQueue} from './node-queue.js';
import {systemClock} from '../system-clock.js';
// @ts-expect-error Shared source fixture for child processes and executable examples.
import {application} from '../../../tests/fixtures/parallel-workflow.mjs';
const input=[{id:'a',value:1},{id:'b',value:2},{id:'c',value:3}];
async function setup(t:{after(fn:()=>Promise<void>):void},options:any={}){
 const root=await mkdtemp(join(tmpdir(),'af-parallel-'));let store=await SqliteRunRecordStore.open(join(root,'db')),now=1000;const clock={now:()=>now,sleep:systemClock.sleep};const a=application({...options,clock});let queue=new PersistentNodeQueue(store,a.configuration,clock);let seq=0;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return {root,a,clock,advance:(ms=10)=>now+=ms,store:()=>store,queue:()=>queue,worker:()=>new NodeWorker(queue,{open:a.open},clock,`worker-${++seq}`,['json'],300),
 async submit(value:any=input){await a.runtime.preparePersisted(a.compiled,'run',value,queue.records());},
 async reopen(){store.close();store=await SqliteRunRecordStore.open(join(root,'db'));queue=new PersistentNodeQueue(store,a.configuration,clock);},
 async load(){const l=await loadWorkflowCheckpoint(a.compiled,'run',queue.records());const c=l.checkpoint;await l.dispose();return c;}};
}
test('Map expands once, waits without a Worker, completes out of order and joins original indices',async t=>{
 const completed:string[]=[],s=await setup(t,{maxConcurrency:3,observe:async({input,component}:any)=>{if(component!=='finish'){await new Promise(r=>setTimeout(r,({a:100,b:10,c:40} as any)[input.id]));completed.push(input.id);}}});
 await s.submit();const expansion=await s.worker().runOnce();assert.equal(expansion!.waiting,'PARALLEL_WAIT');assert.equal(expansion!.error,null);
 assert.equal((await s.queue().query())[0]!.state,'waiting');assert.equal((await s.queue().query())[0]!.owner,null);assert.equal((await s.queue().query()).length,4);assert.equal((await s.load()).attempts.length,1);
 const children=await Promise.all([s.worker().runOnce(),s.worker().runOnce(),s.worker().runOnce()]);assert.ok(children.every(r=>r?.error===null));assert.deepEqual(completed,['b','c','a']);
 const joined=await s.worker().runOnce();assert.equal(joined!.error,null);assert.equal(joined!.snapshot!.steps.length,1);
 const output=(joined!.snapshot!.lastAccepted!.result as any).output;assert.deepEqual(output.items.map((i:any)=>i.id),['a','b','c']);assert.deepEqual(output.items.map((i:any)=>i.index),[0,1,2]);assert.deepEqual(output.items.map((i:any)=>i.output),input);
 const done=await s.worker().runOnce();assert.equal(done!.snapshot!.status,'succeeded');assert.equal(await s.worker().runOnce(),null);assert.equal((await s.load()).attempts.length,2);
});
test('Fork uses the same logical input and joins lexicographic branch IDs; empty Map is valid',async t=>{
 for(const kind of ['fork','map']){const s=await setup(t,{kind}),value=kind==='fork'?{id:'request',value:7}:[];
  // A scheduler pause must not consume logical lease time in this structure test.
  const open=s.a.open;let delayed=false;s.a.open=async(...args:Parameters<typeof open>)=>{if(!delayed){delayed=true;const until=Date.now()+350;while(Date.now()<until){/* force a pause longer than the fixture lease */}}return open(...args);};
  await s.submit(value);const expanded=(await s.worker().runOnce())!;assert.equal(expanded.error,null,JSON.stringify(expanded));assert.equal(expanded.waiting,'PARALLEL_WAIT');
  await s.worker().runUntilIdle();const c=await s.load();assert.equal(c.snapshot.status,'succeeded');const output=(c.snapshot.lastAccepted!.result as any).output;
  if(kind==='fork'){assert.deepEqual(output.branches.map((b:any)=>b.id),['alpha','zeta']);assert.deepEqual(output.branches.map((b:any)=>b.output),[value,value]);}else assert.deepEqual(output,{items:[]});}
});
test('all Map item IDs and contracts are checked before any child is created',async t=>{
 for(const value of [{bad:true},[{id:'a',value:1},{id:'a',value:2}],[{id:' ',value:1}],[{id:'a',value:'bad'}]]){
  const s=await setup(t);await s.submit(value);const result=await s.worker().runOnce();assert.equal(result!.snapshot!.status,'failed');assert.equal((await s.queue().query()).length,1);
 }
});
test('group and shared role capacity combine and no extra Worker is held by the parent',async t=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r),s=await setup(t,{maxConcurrency:1,roleCapacity:3,observe:async({component}:any)=>{if(component!=='finish')await held;}});
 await s.submit();await s.worker().runOnce();const first=s.worker().runOnce();
 for(let n=0;n<100&&(await s.queue().query()).filter(t=>t.state==='leased').length!==1;n++)await new Promise(r=>setTimeout(r,2));
 assert.equal(await s.worker().runOnce(),null);assert.equal((await s.queue().query()).filter(t=>t.reason==='PARALLEL_CAPACITY').length,2);release();await first;await s.worker().runUntilIdle();assert.equal((await s.load()).snapshot.status,'succeeded');
});
test('wait-all preserves successful items and withholds the successor after one final failure',async t=>{
 const seen:string[]=[],s=await setup(t,{retry:null,observe:async({input,component}:any)=>{seen.push(component==='finish'?'finish':input.id);if(input.id==='b')return 'IMPLEMENTATION_FAILED';}});
 await s.submit();await s.worker().runOnce();await s.worker().runUntilIdle();
 assert.ok(seen.includes('a')&&seen.includes('c'));assert.ok(!seen.includes('finish'));const c=await s.load();assert.equal(c.snapshot.status,'failed');assert.equal(c.snapshot.reason,'PARALLEL_CHILDREN_FAILED');assert.equal(c.snapshot.issues[0]!.rule,'b');
});
test('waiting group cancellation cancels unstarted units and terminates without a normal successor',async t=>{
 const seen:string[]=[],s=await setup(t,{observe:async({component}:any)=>seen.push(component)});await s.submit();await s.worker().runOnce();assert.equal(await s.queue().cancelReady('run'),true);
 const result=await s.worker().runOnce();assert.equal(result!.error,null);assert.equal(result!.snapshot!.status,'cancelled');assert.deepEqual(seen,[]);assert.equal(await s.worker().runOnce(),null);assert.equal((await s.load()).snapshot.status,'cancelled');
});

test('retry after reopening only repeats the failed child and preserves parent expansion',async t=>{
 const calls:any[]=[],s=await setup(t,{observe:async({component,input,identity}:any)=>{calls.push({component,id:input.id,attempt:identity.attemptNumber});return input.id==='b'&&identity.attemptNumber===1?'IMPLEMENTATION_FAILED':undefined;}});
 await s.submit();await s.worker().runOnce();const expanded=(await s.load()).attempts[0]!.parallel;
 await s.worker().runOnce();const first=await s.worker().runOnce();assert.equal(first!.waiting,'RETRY_WAIT');
 await s.reopen();s.advance();await s.worker().runUntilIdle();const c=await s.load();assert.equal(c.snapshot.status,'succeeded');assert.deepEqual(c.attempts[0]!.parallel,expanded);
 assert.equal(calls.filter(x=>x.id==='a').length,1);assert.deepEqual(calls.filter(x=>x.id==='b').map(x=>x.attempt),[1,2]);assert.equal(calls.filter(x=>x.id==='c').length,1);assert.equal(calls.filter(x=>x.component==='finish').length,1);
});
test('expansion transaction failure publishes no partial children and normal recovery expands once',async t=>{
 const s=await setup(t);await s.submit();let reject=true;
 const raw=s.store(),store={create:raw.create.bind(raw),read:raw.read.bind(raw),compareAndSwap:raw.compareAndSwap.bind(raw),commitRecords:async(...args:Parameters<typeof raw.commitRecords>)=>{
  if(reject&&args[1].some(w=>(w.content as any).snapshot?.status==='parallel_wait'))throw new RunStoreError('RUN_STORE_IO_ERROR');return raw.commitRecords(...args);
 }};
 const queue=new PersistentNodeQueue(store,s.a.configuration,s.clock),worker=()=>new NodeWorker(queue,{open:s.a.open},s.clock,'worker',['json'],300);
 const failed=await worker().runOnce();assert.ok(failed!.error);assert.equal((await queue.query()).length,1);assert.equal((await s.load()).attempts[0]!.parallel,undefined);
 reject=false;await queue.retryRecovery('run/task-1');assert.equal((await worker().runOnce())!.waiting,'PARALLEL_WAIT');assert.equal((await queue.query()).length,4);
 await worker().runUntilIdle();const final=await s.load();assert.equal(final.snapshot.status,'succeeded');assert.equal(final.attempts.filter(a=>a.parallel).length,1);
});
test('active child cancellation is cooperative and parent waits for its confirmed terminal result',async t=>{
 let started!:()=>void;const active=new Promise<void>(r=>started=r),s=await setup(t,{maxConcurrency:1,observe:async({component,cancel}:any)=>{if(component==='finish')throw new Error('UNEXPECTED_SUCCESSOR');started();const deadline=Date.now()+3000;while(!cancel.requested()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));if(!cancel.requested())throw new Error('CANCELLATION_NOT_OBSERVED');}});
 await s.submit();await s.worker().runOnce();const running=s.worker().runOnce();await active;assert.equal(await s.queue().cancelReady('run'),true);
 assert.equal((await s.load()).snapshot.status,'cancelling');const child=await running;assert.equal(child!.error,null);assert.equal(child!.snapshot!.status,'cancelled');
 const parent=await s.worker().runOnce();assert.equal(parent!.error,null);assert.equal(parent!.snapshot!.status,'cancelled');assert.equal(await s.worker().runOnce(),null);
});
test('join contract failure reports final failure and never calls the successor',async t=>{
 let finish=0;const s=await setup(t,{badJoin:true,observe:async({component}:any)=>{if(component==='finish')finish++;}});await s.submit();await s.worker().runUntilIdle();
 assert.equal((await s.load()).snapshot.reason,'INVALID_PARALLEL_OUTPUT');assert.equal(finish,0);assert.ok((await s.queue().query()).every(t=>t.state==='done'));
});
test('persisted expansion IDs cannot be retargeted to foreign child records',async t=>{
 const s=await setup(t);await s.submit();await s.worker().runOnce();const row=(await s.queue().records().read('run'))!,content=structuredClone(row.content) as any;
 content.attempts[0].parallel.children[0].runId='foreign';const records={...s.queue().records(),read:async()=>({...row,content})};
 await assert.rejects(loadWorkflowCheckpoint(s.a.compiled,'run',records),/INVALID_WORKFLOW_CHECKPOINT/);
});

test('shared role and credential caps further restrict a larger parallel node limit',async t=>{
 for(const options of [{roleCapacity:1,credentialCapacity:null,reason:'ROLE_CAPACITY'},{roleCapacity:3,credentialCapacity:1,reason:'CREDENTIAL_CAPACITY'}]){
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>release=r),active=new Promise<void>(r=>started=r);
  const s=await setup(t,{...options,maxConcurrency:3,observe:async()=>{started();await held;}});await s.submit();await s.worker().runOnce();const first=s.worker().runOnce();await active;
  assert.equal(await s.worker().runOnce(),null);assert.equal((await s.queue().query()).filter(t=>t.reason===options.reason).length,2);release();await first;await s.worker().runUntilIdle();assert.equal((await s.load()).snapshot.status,'succeeded');
 }
});

test('cancellation during reclaim of a retry-waiting child consumes no new Attempt',async t=>{
 const s=await setup(t,{observe:async()=> 'IMPLEMENTATION_FAILED'});await s.submit([{id:'b',value:2}]);await s.worker().runOnce();assert.equal((await s.worker().runOnce())!.waiting,'RETRY_WAIT');
 let claimed!:()=>void,release!:()=>void;const started=new Promise<void>(r=>claimed=r),held=new Promise<void>(r=>release=r);
 s.advance();const worker=new NodeWorker(s.queue(),{open:async(...args)=>{const app=await s.a.open(...args);claimed();await held;return app;}},s.clock,'cancelled-worker',['json'],300);
 const running=worker.runOnce();await started;assert.equal(await s.queue().cancelReady('run'),true);release();const result=await running;assert.equal(result!.error,null);assert.equal(result!.snapshot!.status,'cancelled');
 const parent=await s.worker().runOnce();assert.equal(parent!.error,null);assert.equal(parent!.snapshot!.status,'cancelled');const metadata=(await s.load()).attempts[0]!.parallel!;const child=(await s.queue().records().read(metadata.children[0]!.runId))!.content as any;assert.equal(child.attempts.length,1);assert.equal(child.snapshot.retry,undefined);
});
