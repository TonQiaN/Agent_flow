import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,fork} from 'node:child_process';
import {once} from 'node:events';
import {FileCredentialStore,CodexSubscriptionCodec,ClaudeSubscriptionCodec,SqliteRunRecordStore} from '@agentflow/integrations';
import {docker} from '../../packages/integrations/docker/process.js';
const enabled=process.env['AGENTFLOW_EGRESS_TESTS']==='1',image=`agentflow-test/subscription-recovery:${randomUUID()}`;
let build:string;
const credential=(provider:string)=>({credentialRef:'fixture',service:provider==='codex'?'openai':'anthropic',method:'subscription'});
const auth=(provider:string,token='fixture-original')=>JSON.stringify(provider==='codex'?{auth_mode:'chatgpt',tokens:{id_token:'fixture-id',access_token:token,refresh_token:'fixture-refresh',account_id:'fixture-account'}}:{claudeAiOauth:{accessToken:token,refreshToken:'fixture-refresh',expiresAt:2000000000000,scopes:['user:inference']}});
before(async()=>{
 if(!enabled)return;build=await mkdtemp(join(tmpdir(),'af-subscription-build-'));
 for(const provider of ['codex','claude']){
  let script=(await readFile(new URL(`./${provider}-composition.test.ts`,import.meta.url),'utf8')).split('const executable = `')[1]!.split('`;')[0]!;
  // Reuse the existing protocol substitute; replace only its business fixture with Tutor files.
  const start=script.indexOf("const input='/task/input/numbers.json'"),end=script.indexOf('const schema=',start);assert.ok(start>0&&end>start);
  script=script.slice(0,start)+`const until=Date.now()+1800;while(Date.now()<until){}\nfs.cpSync('/task/input','/task/outputs',{recursive:true});\nfs.copyFileSync('/usr/local/share/fixture/correct.json','/task/outputs/candidate.json');\n`+script.slice(end);
  // The extracted template has one doubled escape used by the original JS string literal.
  script=script.replaceAll('\\\\n','\\n');await writeFile(join(build,provider),script);
 }
 await cp(new URL('../../examples/tutor-grading/fixtures/correct.json',import.meta.url),join(build,'correct.json'));
 await writeFile(join(build,'Dockerfile'),'FROM node:22-bookworm-slim\nCOPY --chmod=755 codex claude /usr/local/bin/\nCOPY correct.json /usr/local/share/fixture/\n');
 execFileSync('docker',['build','--network','none','--pull=false','--tag',image,build],{stdio:'pipe',timeout:60000});
});
after(async()=>{if(build){await docker(['image','rm',image]).catch(()=>{});await rm(build,{recursive:true,force:true});}});
function child(root:string,provider:string,operation:string,point='none'){
 const process=fork(new URL('../fixtures/tutor-persistent-workflow.mjs',import.meta.url),[root,operation,'correct',point,image,'unused',provider],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';process.stdout!.on('data',b=>stdout+=b);process.stderr!.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>process.kill('SIGKILL'),60000),exited=once(process,'exit').finally(()=>clearTimeout(timer));return{process,exited,output:()=>({stdout,stderr})};
}
async function record(root:string){const store=await SqliteRunRecordStore.open(join(root,'runs'));try{return(await store.read('run'))!;}finally{store.close();}}
async function complete(root:string,provider:string,operation:string){const c=child(root,provider,operation),[code]=await c.exited;assert.equal(code,0,JSON.stringify(c.output()));return JSON.parse(c.output().stdout);}
for(const provider of ['codex','claude'])for(const point of ['agent','before-publish'])test(`${provider} subscription resumes the entire Tutor workflow after ${point} SIGKILL, retaining refresh and accepted steps`,{skip:!enabled,timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'af-subscription-workflow-')),source=new FileCredentialStore(join(root,'credentials'),[provider==='codex'?new CodexSubscriptionCodec():new ClaudeSubscriptionCodec()]);
 await mkdir(join(root,'source'));await cp(new URL('../../examples/tutor-grading/fixtures/source',import.meta.url),join(root,'source/source'),{recursive:true});await source.configure(credential(provider),{content:auth(provider)});
 try{
  const c=child(root,provider,'run',point);const [message]=await Promise.race([once(c.process,'message'),c.exited.then(()=>{throw new Error(JSON.stringify(c.output()));})]);assert.equal(message.point,point);assert.deepEqual(await c.exited,[null,'SIGKILL']);
  const prior:any=await record(root),attempt=prior.content.attempts.at(-1),resource=attempt.phases?.find((p:any)=>p.id==='execution')?.resource;
  if(point==='agent'){
   assert.equal(JSON.parse(await docker(['inspect',resource.resource.id]))[0].State.Running,true);
   await assert.rejects(source.acquire(credential(provider)),/CREDENTIAL_BUSY/);
   const privateState=resource.execution.privateState;assert.equal(privateState.schema,'agentflow-subscription-resource/v1');assert.ok(!JSON.stringify(prior).includes('fixture-original'));assert.ok(!JSON.stringify(prior).includes('generation'));
   // Ensure the live CLI has actually refreshed before recovery stops it.
   const path=join(resource.backend.directory,'state',provider,provider==='codex'?'auth.json':'.credentials.json');
   for(let n=0;n<60;n++){if((await readFile(path,'utf8')).includes('fixture-access-refreshed'))break;await new Promise(r=>setTimeout(r,25));}
   assert.ok((await readFile(path,'utf8')).includes('fixture-access-refreshed'));
  }else await source.configure(credential(provider),{content:auth(provider,'fixture-current-login')});
  for(const name of ['source','temporary','nodes','transforms'])await rm(join(root,name),{recursive:true,force:true});
  const loaded=await complete(root,provider,'load');assert.equal(loaded.acquisitions,0);assert.deepEqual(loaded.calls,[]);
  const result=await complete(root,provider,'resume');assert.equal(result.snapshot.status,'succeeded');assert.equal(result.snapshot.outcome,'published');assert.deepEqual(result.snapshot.steps.slice(0,prior.content.snapshot.steps.length),prior.content.snapshot.steps);
  assert.equal((await readFile(join(root,'external.jsonl'),'utf8')).trim().split('\n').length,1);assert.equal(result.receipt.output.total,5);
  if(point==='agent'){await assert.rejects(docker(['inspect',resource.resource.id]));assert.equal(result.acquisitions,1);assert.equal((await source.inspect(credential(provider)))!.revision,2);assert.ok(result.record.content.attempts.some((a:any)=>a.identity.nodeTaskId===attempt.identity.nodeTaskId&&a.identity.attemptNumber===2));}
  else {assert.equal(result.acquisitions,0);const lease=await source.acquire(credential(provider));try{assert.equal(await lease.readSecret(),auth(provider,'fixture-current-login'));}finally{await lease.release();}}
 }finally{
  const saved:any=(await record(root))?.content,c=saved?.checkpoint??saved;for(const a of c?.attempts??[])for(const r of [a.resource,...(a.phases??[]).map((p:any)=>p.resource)].filter(Boolean)){const id=r.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}await rm(root,{recursive:true,force:true});
 }
});
