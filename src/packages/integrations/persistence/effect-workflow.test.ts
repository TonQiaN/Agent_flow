import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SqliteRunRecordStore } from './sqlite-store.js';
const worker = fileURLToPath(new URL('../../../tests/fixtures/effect-workflow.mjs',import.meta.url));
async function fixture(t:{after(fn:()=>Promise<void>):void}) { const root=await mkdtemp(join(tmpdir(),'af-effect-workflow-'));t.after(()=>rm(root,{recursive:true,force:true}));return root; }
function child(root:string,mode:string,variant='same') {
 const process=fork(worker,[root,mode,variant],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let stderr='';process.stderr!.on('data',b=>{stderr+=b;});
 const exited=once(process,'exit'); const message=()=>Promise.race([once(process,'message').then(([m])=>m),exited.then(([code,signal])=>{throw new Error(`${code}/${signal} ${stderr}`);})]);
 return {process,exited,message};
}
async function complete(root:string,mode:string,variant='same') { const p=child(root,mode,variant);const result=await p.message();assert.deepEqual(await p.exited,[0,null]);return result; }
async function record(root:string) {const store=await SqliteRunRecordStore.open(join(root,'runs'));try{return await store.read('run');}finally{store.close();}}
async function writes(root:string) {return (await readFile(join(root,'external.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
async function crash(root:string,point:string) {const p=child(root,point);assert.equal((await p.message()).point,point);assert.deepEqual(await p.exited,[null,'SIGKILL']);}
for(const point of ['before-reserve','reserved','after-effect','after-receipt']) test(`actual Effect Workflow preserves A and handles B host crash at ${point}`,{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,point);const before=await record(root);assert.equal((before!.content as any).snapshot.steps.length,1);
 const result=await complete(root,'recover');
 if(['reserved','after-effect'].includes(point)) {assert.equal(result.error,'EFFECT_RESULT_UNKNOWN');assert.deepEqual(result.record,before);assert.deepEqual(result.approvals,[]);}
 else {assert.equal(result.error,undefined);assert.equal(result.result.status,'succeeded');assert.equal(result.result.steps[0].result.identity.attemptNumber,1);assert.equal(result.result.steps[1].result.identity.attemptNumber,2);assert.equal(result.result.steps[1].result.outcome,point==='after-receipt'?'already-applied':'applied');assert.deepEqual(result.approvals.map((i:any)=>i.nodeTaskId),['task-2']);assert.deepEqual(result.calls,point==='after-receipt'?[]:['b']);}
 const actual=await writes(root);assert.equal(actual.filter(r=>r.componentId==='a').length,1);assert.equal(actual.filter(r=>r.componentId==='b').length,point==='reserved'?0:1);
 const loaded=await complete(root,'load');assert.equal(loaded.error,undefined);assert.deepEqual(loaded.calls,[]);assert.deepEqual(loaded.approvals,[]);
});
test('Effect recovery still needs current explicit approval and never revives an old grant',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-receipt');const result=await complete(root,'recover','no-approval');assert.equal(result.result.status,'failed');assert.equal(result.result.reason,'EFFECT_NOT_AUTHORIZED');assert.deepEqual(result.calls,[]);assert.equal((await writes(root)).length,2);
});
test('late original Effect host cannot overwrite recovered state or double-apply',{timeout:15000},async t=>{
 const root=await fixture(t),old=child(root,'hold-before-reserve');t.after(()=>{old.process.kill();});assert.equal((await old.message()).point,'before-reserve');
 const resumed=await complete(root,'recover');assert.equal(resumed.result.status,'succeeded');const saved=await record(root);
 const finished=old.message();old.process.send('continue');assert.equal((await finished).error,'RUN_REVISION_CONFLICT');assert.deepEqual(await old.exited,[0,null]);assert.deepEqual(await record(root),saved);assert.equal((await writes(root)).length,2);
});
test('two Effect recovery processes compete on one Run revision without duplicate side effects',{timeout:15000},async t=>{
 const root=await fixture(t);await crash(root,'after-receipt');const peers=[child(root,'recover-compete'),child(root,'recover-compete')];t.after(()=>{for(const p of peers)p.process.kill();});
 await Promise.all(peers.map(async p=>assert.equal((await p.message()).point,'read')));const next=peers.map(p=>p.message());for(const p of peers)p.process.send('continue');const results=await Promise.all(next);await Promise.all(peers.map(async p=>assert.deepEqual(await p.exited,[0,null])));
 assert.equal(results.filter(r=>r.result?.status==='succeeded').length,1);assert.equal(results.filter(r=>r.error==='RUN_REVISION_CONFLICT').length,1);assert.equal((await writes(root)).length,2);
});
test('Effect loading validates actual service, operation, journal identity and accepted receipt/input facts',{timeout:15000},async t=>{
 const root=await fixture(t),initial=await complete(root,'run');assert.equal(initial.result.status,'succeeded');const original=await record(root);
 for(const variant of ['version','identity','target','journal']) {const result=await complete(root,'load',variant);assert.equal(result.error,'WORKFLOW_EXECUTION_MISMATCH');assert.deepEqual(result.calls,[]);assert.deepEqual(result.approvals,[]);assert.deepEqual(await record(root),original);}
 const store=await SqliteRunRecordStore.open(join(root,'runs'));
 try {for(const mutate of [(c:any)=>{c.values[0].value={value:2};c.values[0].saved.value={value:2};},(c:any)=>{c.values[1].value.reference='forged';c.values[1].saved.value.reference='forged';c.snapshot.steps[0].result.output.reference='forged';}]) {
  const changed=structuredClone(original!.content);mutate(changed);await store.compareAndSwap('run',(await store.read('run'))!.revision,changed);const before=await store.read('run');
  const result=await complete(root,'load');assert.ok(['EFFECT_KEY_CONFLICT','INVALID_DURABLE_EFFECT_RECEIPT'].includes(result.error));assert.deepEqual(result.calls,[]);assert.deepEqual(result.approvals,[]);assert.deepEqual(await store.read('run'),before);
 }}finally {await store.compareAndSwap('run',(await store.read('run'))!.revision,original!.content);store.close();}
 assert.equal((await complete(root,'load')).error,undefined);assert.equal((await writes(root)).length,2);
});

test('configured retry preserves real Effect journal protection and reuses receipts with current approval',{timeout:15000},async t=>{
 for(const point of ['after-effect','after-receipt']){
  const root=await fixture(t),p=child(root,point,'retry');assert.equal((await p.message()).point,point);assert.deepEqual(await p.exited,[null,'SIGKILL']);
  const before=await record(root),first=await complete(root,'recover','retry');
  if(point==='after-effect'){
   assert.equal(first.error,'EFFECT_RESULT_UNKNOWN');assert.deepEqual(first.record,before);assert.equal((await complete(root,'recover','retry')).error,'EFFECT_RESULT_UNKNOWN');
  }else{
   assert.equal(first.result.status,'retry_wait');assert.equal(first.record.content.attempts[1].retry.result.code,'ATTEMPT_INTERRUPTED');
   const final=await complete(root,'recover','retry');assert.equal(final.result.status,'succeeded');assert.equal(final.result.steps[1].result.outcome,'already-applied');
   assert.deepEqual(final.approvals.map((i:any)=>i.attemptNumber),[2]);assert.deepEqual(final.calls,[]);
  }
  assert.equal((await writes(root)).length,2);
 }
});
