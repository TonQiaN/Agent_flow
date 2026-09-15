import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore, FileCredentialStore, DeepSeekApiKeyCodec } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled=process.env['AGENTFLOW_EGRESS_TESTS']==='1',image=`agentflow-test/tutor-persistent:${randomUUID()}`;
let build:string,assetsPath:string;
before(async()=>{
 if(!enabled)return;build=await mkdtemp(join(tmpdir(),'af-tutor-build-'));assetsPath=join(build,'assets.json');
 await writeFile(assetsPath,execFileSync(process.execPath,['src/apps/deepseek-tools/export-assets.mjs']));
 let cli=await readFile(new URL('../fixtures/deepseek-protocol.cjs',import.meta.url),'utf8');
 const start=cli.indexOf("  const source = '/task/input/numbers.json'"),end=cli.indexOf('  const outcome =',start);assert.ok(start>=0&&end>start);
 cli=cli.slice(0,start)+`  await new Promise(resolve=>setTimeout(resolve,1500));
  fs.cpSync('/task/input','/task/outputs',{recursive:true});
  fs.appendFileSync('/task/input/source/paper.json','\\n');
  fs.copyFileSync('/usr/local/share/fixture/'+(prompt==='correct'?'correct':'wrong')+'.json','/task/outputs/candidate.json');
  if(prompt==='source-tamper')fs.writeFileSync('/task/outputs/source/key.json','{"q1":5,"q2":8,"q3":12}');
`+cli.slice(end);
 await writeFile(join(build,'dsh'),cli);await writeFile(join(build,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.1-rc.2'}));
 for(const name of ['correct','wrong'])await cp(new URL(`../../examples/tutor-grading/fixtures/${name}.json`,import.meta.url),join(build,`${name}.json`));
 await writeFile(join(build,'Dockerfile'),'FROM node:22-bookworm-slim\nCOPY --chmod=755 dsh /usr/local/bin/dsh\nCOPY package.json /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json\nCOPY correct.json wrong.json /usr/local/share/fixture/\n');
 execFileSync('docker',['build','--network','none','--pull=false','--tag',image,build],{stdio:'pipe',timeout:60000});
});
after(async()=>{if(build){await docker(['image','rm',image]).catch(()=>{});await rm(build,{recursive:true,force:true});}});
async function setup(){const root=await mkdtemp(join(tmpdir(),'af-tutor-persist-'));await mkdir(join(root,'source'));await cp(new URL('../../examples/tutor-grading/fixtures/source',import.meta.url),join(root,'source','source'),{recursive:true});
 const source=new FileCredentialStore(join(root,'credentials'),[new DeepSeekApiKeyCodec()]);await source.configure({credentialRef:'fixture',service:'deepseek',method:'api-key'},{content:JSON.stringify({schema:'agentflow-deepseek-key/v1',api_key:'fixture-deepseek-key'})});return root;}
function child(root:string,operation:string,variant='wrong',point='none'){
 const process=fork(new URL('../fixtures/tutor-persistent-workflow.mjs',import.meta.url),[root,operation,variant,point,image,assetsPath],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';process.stdout!.on('data',b=>stdout+=b);process.stderr!.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>process.kill('SIGKILL'),65000),exited=once(process,'exit').finally(()=>clearTimeout(timer));return{process,exited,output:()=>({stdout,stderr})};
}
async function complete(root:string,operation:string,variant='wrong'){const c=child(root,operation,variant);const [code]=await c.exited;let value:any;try{value=JSON.parse(c.output().stdout);}catch{throw new Error(c.output().stderr+c.output().stdout);}if(!value.error)assert.equal(code,0,c.output().stderr);return value;}
async function crash(root:string,point:string){const c=child(root,'run','wrong',point);const [message]=await Promise.race([once(c.process,'message'),c.exited.then(()=>{throw new Error(c.output().stdout+c.output().stderr);})]);assert.equal(message.point,point);assert.deepEqual(await c.exited,[null,'SIGKILL']);}
async function record(root:string){const db=await SqliteRunRecordStore.open(join(root,'runs'));try{return(await db.read('run'))!;}finally{db.close();}}
async function writes(root:string){try{return(await readFile(join(root,'external.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}}
async function eraseInputs(root:string){for(const name of ['source','temporary','nodes','transforms'])await rm(join(root,name),{recursive:true,force:true});}
async function cleanup(root:string){const saved:any=(await record(root))?.content,c=saved?.checkpoint??saved;for(const a of c?.attempts??[])for(const r of [a.resource,...(a.phases??[]).map((p:any)=>p.resource)].filter(Boolean)){const id=r.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}await rm(root,{recursive:true,force:true});}
for(const variant of ['correct','wrong','source-tamper','no-repair'])test(`persistent Tutor actual Agent/Script/projection/Effect composition: ${variant}`,{skip:!enabled,timeout:70000},async()=>{
 const root=await setup();try{const r=await complete(root,'run',variant);assert.equal(r.error,undefined);assert.equal(r.snapshot.status,variant==='no-repair'?'exhausted':'succeeded');
  const rejected=['source-tamper','no-repair'].includes(variant);assert.equal(r.snapshot.outcome,rejected?'rejected':'published');assert.equal((await writes(root)).length,rejected?0:1);
  if(!rejected){assert.equal(r.matches,true);assert.equal(r.receipt.output.total,5);assert.deepEqual(r.calls,variant==='correct'?['marker','publish']:['marker','fixer','publish']);}
  assert.equal(await readFile(join(root,'source','source','paper.json'),'utf8'),await readFile(new URL('../../examples/tutor-grading/fixtures/source/paper.json',import.meta.url),'utf8'));
  await eraseInputs(root);const loaded=await complete(root,'load',variant);assert.equal(loaded.error,undefined);assert.deepEqual(loaded.snapshot,r.snapshot);assert.deepEqual(loaded.calls,[]);assert.deepEqual(loaded.approvals,[]);assert.equal(loaded.acquisitions,0);
 }finally{await cleanup(root);}
});
for(const point of ['agent','gate','before-publish','after-receipt'])test(`persistent Tutor resumes after ${point} host SIGKILL without replaying accepted work`,{skip:!enabled,timeout:90000},async()=>{
 const root=await setup();try{await crash(root,point);const prior:any=await record(root);
  if(point==='agent'){const resource=prior.content.attempts.at(-1).phases.at(-1).resource.resource;assert.equal(JSON.parse(await docker(['inspect',resource.id]))[0].State.Running,true);}
  await eraseInputs(root);const r=await complete(root,'resume');assert.equal(r.error,undefined);assert.equal(r.snapshot.status,'succeeded');assert.equal(r.snapshot.outcome,'published');
  assert.deepEqual(r.snapshot.steps.slice(0,prior.content.snapshot.steps.length),prior.content.snapshot.steps);assert.equal((await writes(root)).length,1);assert.equal(r.matches,true);
  const old=prior.content.attempts.at(-1);
  for(const resource of [old.resource,...(old.phases??[]).map((p:any)=>p.resource)].filter(Boolean))await assert.rejects(docker(['inspect',resource.resource.id]));
  const next=r.record.content.attempts.find((a:any)=>a.identity.nodeTaskId===old.identity.nodeTaskId&&a.identity.attemptNumber===2);assert.ok(next);
  if(['before-publish','after-receipt'].includes(point)){assert.equal(r.acquisitions,0);assert.ok(!r.calls.includes('marker')&&!r.calls.includes('fixer'));assert.deepEqual(r.receipt.identity,prior.content.snapshot.steps.find((s:any)=>s.node==='projection').result.identity);}
  if(point==='after-receipt'){assert.deepEqual(r.calls,[]);assert.equal(r.snapshot.lastAccepted.result.outcome,'already-applied');}
  const loaded=await complete(root,'load');assert.equal(loaded.error,undefined);assert.equal(loaded.acquisitions,0);assert.deepEqual(loaded.calls,[]);
 }finally{await cleanup(root);}
});
test('persistent Tutor retains unknown external publication and never blindly repeats it',{skip:!enabled,timeout:70000},async()=>{
 const root=await setup();try{await crash(root,'after-effect');const before=await record(root);assert.equal((await writes(root)).length,1);const r=await complete(root,'resume');assert.equal(r.error,'EFFECT_RESULT_UNKNOWN');assert.deepEqual(r.calls,[]);assert.equal(r.acquisitions,0);assert.deepEqual(r.approvals,[]);assert.deepEqual(await record(root),before);assert.equal((await writes(root)).length,1);}finally{await cleanup(root);}
});
test('persistent Tutor recovery still requires current approval, and operation drift cannot mutate the Run',{skip:!enabled,timeout:70000},async()=>{
 const root=await setup();try{await crash(root,'before-publish');const before=await record(root);const drift=await complete(root,'resume','key-drift');assert.equal(drift.error,'WORKFLOW_EXECUTION_MISMATCH');assert.deepEqual(await record(root),before);assert.deepEqual(drift.calls,[]);
  const denied=await complete(root,'resume','no-approval');assert.equal(denied.error,undefined);assert.equal(denied.snapshot.status,'failed');assert.equal(denied.snapshot.reason,'EFFECT_NOT_AUTHORIZED');assert.equal(denied.acquisitions,0);assert.deepEqual(denied.calls,[]);assert.equal((await writes(root)).length,0);
 }finally{await cleanup(root);}
});
