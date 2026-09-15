import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SqliteRunRecordStore } from '@agentflow/integrations';
const enabled=process.env['AGENTFLOW_DOCKER_TESTS']==='1';
const worker=fileURLToPath(new URL('../fixtures/tutor-script-workflow.mjs',import.meta.url));
const execute=promisify(execFile);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'af-tutor-scripts-'));await cp(fileURLToPath(new URL('../../examples/tutor-grading/fixtures/source',import.meta.url)),join(root,'source/source'),{recursive:true});
 return root;
}
function child(root:string,mode:string,variant:string,interrupt='no'){
 const process=fork(worker,[root,mode,variant,interrupt],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';process.stdout!.on('data',b=>stdout+=b);process.stderr!.on('data',b=>stderr+=b);
 return{process,exited:once(process,'exit'),text:()=>({stdout,stderr})};
}
async function complete(root:string,mode:string,variant:string,interrupt='no',expected=0){const p=child(root,mode,variant,interrupt);assert.deepEqual(await p.exited,[expected,null],JSON.stringify(p.text()));return JSON.parse(p.text().stdout);}
for(const variant of ['correct','wrong','source-tamper'])test(`actual Tutor file Scripts preserve grading contracts and ${variant} route`,{skip:!enabled,timeout:45000},async()=>{
 const root=await fixture();let removable=false;
 try{
  const source=await readFile(join(root,'source/source/key.json'),'utf8'),result=await complete(root,'run',variant);
  assert.equal(result.snapshot.status,'succeeded');assert.equal(result.snapshot.outcome,variant==='source-tamper'?'rejected':'passed');
  assert.deepEqual(result.started,variant==='wrong'?['intake','marker','gate','fixer','gate']:['intake','marker','gate']);
  assert.equal(result.report.decision,variant==='source-tamper'?'rejected':'passed');assert.equal(await readFile(join(root,'source/source/key.json'),'utf8'),source);
  if(variant==='source-tamper')assert.ok(result.report.findings.includes('SOURCE_CHANGED:source/key.json'));else assert.deepEqual(result.report.findings,[]);
  for(const value of result.record.content.values.slice(1)){assert.match(value.saved.receipt.script.imageId,/^sha256:[a-f0-9]{64}$/);assert.equal(value.saved.receipt.agent,null);}
  for(const path of ['source','temporary','nodes','attempts'])await rm(join(root,path),{recursive:true,force:true});
  const loaded=await complete(root,'load',variant);assert.deepEqual(loaded.started,[]);assert.deepEqual(loaded.report,result.report);assert.deepEqual(loaded.snapshot,result.snapshot);removable=true;
 }finally{if(removable)await rm(root,{recursive:true,force:true});else console.error(`Retained Tutor Script evidence: ${root}`);}
});
test('Tutor Gate SIGKILL recovery keeps intake/marker and source facts, stops old container and follows repair normally',{skip:!enabled,timeout:60000},async()=>{
 const root=await fixture();let resource:string|undefined,removable=false;const old=child(root,'run','wrong','yes');
 try{
  const [message]=await Promise.race([once(old.process,'message'),old.exited.then(()=>{throw new Error(JSON.stringify(old.text()));})]);assert.equal(message.point,'gate-running');resource=message.resource.id;
  assert.deepEqual(await old.exited,[null,'SIGKILL']);assert.equal((await execute('docker',['inspect','--format','{{.State.Running}}',resource!])).stdout.trim(),'true');
  const store=await SqliteRunRecordStore.open(join(root,'runs'));let before;try{before=await store.read('run');}finally{store.close();}
  const refused=await complete(root,'source-drift','wrong','yes',1);assert.equal(refused.error,'WORKFLOW_EXECUTION_MISMATCH');assert.deepEqual(refused.started,[]);assert.deepEqual(refused.restored,[]);
  for(const path of ['source','temporary','nodes'])await rm(join(root,path),{recursive:true,force:true});
  const resumed=await complete(root,'resume','wrong','yes');assert.equal(resumed.snapshot.outcome,'passed');assert.deepEqual(resumed.started,['gate','fixer','gate']);assert.deepEqual(resumed.restored,['gate']);
  assert.deepEqual(resumed.snapshot.steps.slice(0,2),(before!.content as any).snapshot.steps);assert.equal(resumed.snapshot.steps[2].result.identity.nodeTaskId,'task-3');assert.equal(resumed.snapshot.steps[2].result.identity.attemptNumber,2);
  assert.deepEqual(resumed.record.content.attempts.map((a:any)=>a.interrupted),[false,false,true,false,false,false]);assert.deepEqual(resumed.report.findings,[]);
  await assert.rejects(execute('docker',['inspect',resource!]));resource=undefined;
  const loaded=await complete(root,'load','wrong','yes');assert.deepEqual(loaded.snapshot,resumed.snapshot);assert.deepEqual(loaded.started,[]);removable=true;
 }finally{
  if(old.process.exitCode===null&&old.process.signalCode===null)old.process.kill('SIGKILL');if(resource)await execute('docker',['rm','-f',resource]);
  if(removable)await rm(root,{recursive:true,force:true});else console.error(`Retained Tutor recovery evidence: ${root}`);
 }
});

test('Tutor source reopens from the first durable Run row after host loss before any node starts',{skip:!enabled,timeout:45000},async()=>{
 const root=await fixture(),old=child(root,'run','correct','queued');let removable=false;
 try{
  const [message]=await Promise.race([once(old.process,'message'),old.exited.then(()=>{throw new Error(JSON.stringify(old.text()));})]);assert.equal(message.point,'source-saved');assert.deepEqual(await old.exited,[null,'SIGKILL']);
  const store=await SqliteRunRecordStore.open(join(root,'runs'));try{const c=(await store.read('run'))!.content as any;assert.equal(c.snapshot.status,'queued');assert.deepEqual(c.attempts,[]);}finally{store.close();}
  for(const path of ['source','temporary','nodes','attempts'])await rm(join(root,path),{recursive:true,force:true});
  const resumed=await complete(root,'resume','correct','queued');assert.equal(resumed.snapshot.outcome,'passed');assert.deepEqual(resumed.started,['intake','marker','gate']);assert.deepEqual(resumed.restored,[]);assert.ok(resumed.record.content.attempts.every((a:any)=>a.identity.attemptNumber===1));
  const loaded=await complete(root,'load','correct','queued');assert.deepEqual(loaded.snapshot,resumed.snapshot);assert.deepEqual(loaded.started,[]);removable=true;
 }finally{if(old.process.exitCode===null&&old.process.signalCode===null)old.process.kill('SIGKILL');if(removable)await rm(root,{recursive:true,force:true});else console.error(`Retained source bootstrap evidence: ${root}`);}
});
