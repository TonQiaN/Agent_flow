import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore, FileCredentialStore, DeepSeekApiKeyCodec, CodexSubscriptionCodec, ClaudeSubscriptionCodec } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled=process.env['AGENTFLOW_EGRESS_TESTS']==='1',image=`agentflow-test/agent-workflow:${randomUUID()}`;
const credential={credentialRef:'fixture',service:'deepseek',method:'api-key'};
let build:string|undefined,assetsPath:string;
before(async()=>{
 if(!enabled)return;build=await mkdtemp(join(tmpdir(),'af-agent-workflow-build-'));assetsPath=join(build,'assets.json');
 await writeFile(assetsPath,execFileSync(process.execPath,['src/apps/deepseek-tools/export-assets.mjs']));
 await writeFile(join(build,'Dockerfile'),'FROM node:22-bookworm-slim\nCOPY --chmod=755 dsh codex claude /usr/local/bin/\nCOPY package.json /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json\n');
 const cli=(await readFile(new URL('../fixtures/deepseek-protocol.cjs',import.meta.url),'utf8')).replace("const source = '/task/input/numbers.json', numbers = JSON.parse(fs.readFileSync(source)).numbers;","const source = fs.existsSync('/task/input/numbers.json') ? '/task/input/numbers.json' : '/task/input/answer.json'; const value = JSON.parse(fs.readFileSync(source)); const numbers = value.numbers ?? [value.sum];");
 for(const provider of ['codex','claude']){
  let script=(await readFile(new URL(`./${provider}-composition.test.ts`,import.meta.url),'utf8')).split('const executable = `')[1]!.split('`;')[0]!;
  script=script.replace("const input='/task/input/numbers.json',numbers=JSON.parse(fs.readFileSync(input,'utf8')).numbers;", "const input=fs.existsSync('/task/input/numbers.json')?'/task/input/numbers.json':'/task/input/answer.json',value=JSON.parse(fs.readFileSync(input,'utf8')),numbers=value.numbers??[value.sum]; const until=Date.now()+1500;while(Date.now()<until){}");
  await writeFile(join(build,provider),script.replaceAll('\\\\n','\\n'));
 }
 await writeFile(join(build,'dsh'),cli);await writeFile(join(build,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.1-rc.2'}));
 execFileSync('docker',['build','--network','none','--pull=false','--tag',image,build],{stdio:'pipe',timeout:60000});
});
after(async()=>{if(build){await docker(['image','rm',image]).catch(()=>{});await rm(build,{recursive:true,force:true});}});
function child(root:string,operation:string,stage='',provider='deepseek'){
 const process=fork(new URL('../fixtures/agent-workflow.mjs',import.meta.url),[root,operation,stage,image,assetsPath,provider],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});
 let stdout='',stderr='';process.stdout!.on('data',b=>stdout+=b);process.stderr!.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>process.kill('SIGKILL'),45000),exited=once(process,'exit').finally(()=>clearTimeout(timer));return{process,exited,output:()=>({stdout,stderr})};
}
async function finish(c:ReturnType<typeof child>){assert.equal((await c.exited)[0],0,c.output().stderr);return JSON.parse(c.output().stdout);}
async function pause(root:string,operation:string,stage:string,provider='deepseek'){const c=child(root,operation,stage,provider);try{return(await Promise.race([once(c.process,'message'),c.exited.then(()=>{let value;try{value=JSON.parse(c.output().stdout);}catch{}throw new Error(c.output().stderr||value?.result?.error||value?.error||'no pause');})]))[0];}finally{if(c.process.exitCode===null&&c.process.signalCode===null){c.process.kill('SIGKILL');await c.exited;}}}
async function setup(){const root=await mkdtemp(join(tmpdir(),'af-agent-workflow-'));await mkdir(join(root,'source'));await writeFile(join(root,'source/numbers.json'),'{"numbers":[1,2,3]}');const source=new FileCredentialStore(join(root,'credentials'),[new DeepSeekApiKeyCodec()]);await source.configure(credential,{content:JSON.stringify({schema:'agentflow-deepseek-key/v1',api_key:'fixture-deepseek-key'})});return{root,source};}
async function record(root:string){const db=await SqliteRunRecordStore.open(join(root,'db'));try{return(await db.read('run'))!;}finally{db.close();}}
async function cleanup(root:string){const saved:any=(await record(root))?.content,c=saved?.checkpoint??saved;for(const a of c?.attempts??[])for(const p of a.phases??[])if(p.resource){const id=p.resource.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}await rm(root,{recursive:true,force:true});}
for(const [stage,interruptions]of [['a:version',1],['b:execution',1],['b:execution',2]]as const)test(`actual Agent Workflow resumes after ${stage}/${interruptions}`,{skip:!enabled,timeout:100000},async()=>{
 const f=await setup();try{
 const first=await pause(f.root,'run',stage);assert.equal(first.credentialCalls,stage==='a:version'?0:2);
 await assert.rejects(readdir(join(f.root,'work')),{code:'ENOENT'});
 assert.equal((await readdir(join(f.root,'artifacts'))).length,stage==='a:version'?1:2);
 if(interruptions===2)assert.equal((await pause(f.root,'resume-pause',stage)).identity.attemptNumber,2);
 const prior:any=(await record(f.root)).content,ids=prior.attempts.flatMap((a:any)=>(a.phases??[]).flatMap((p:any)=>p.resource?[p.resource.resource.id]:[]));
 await assert.rejects(readdir(join(f.root,'driver-inputs')),{code:'ENOENT'});
 const attemptDirectories=prior.attempts.flatMap((a:any)=>(a.phases??[]).flatMap((p:any)=>p.resource?[p.resource.backend.directory]:[]));
 assert.ok((await readdir(join(f.root,'attempts'))).every(name=>!name.startsWith('version-input-')));
 await rm(join(f.root,'source'),{recursive:true});const result=await finish(child(f.root,'resume'));
 assert.equal(result.result.status,'succeeded');assert.deepEqual(result.calls,stage==='a:version'?['a','b']:['b']);assert.equal(result.credentialCalls,result.calls.length);
 const last=result.result.lastAccepted;assert.equal(last.result.identity.attemptNumber,stage==='a:version'?1:interruptions+1);
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'result-output/answer.json'),'utf8')),{sum:6});
 for(const id of ids)assert.equal(await docker(['container','ls','-a','--filter',`name=^/${id}(-proxy)?$`,'--format','{{.ID}}']),'');
 for(const directory of attemptDirectories) await assert.rejects(readdir(directory),{code:'ENOENT'});
 const before=await record(f.root),loaded=await finish(child(f.root,'load'));assert.deepEqual(loaded.calls,[]);assert.equal(loaded.credentialCalls,0);assert.deepEqual(await record(f.root),before);
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'loaded-output/answer.json'),'utf8')),{sum:6});
 }finally{await cleanup(f.root);}
});
test('actual Agent acquisition pending refuses claim without credential access or record mutation',{skip:!enabled,timeout:60000},async()=>{
 const f=await setup();try{const paused=await pause(f.root,'run','b:credential');assert.equal(paused.credentialCalls,1);const before=await record(f.root),c=child(f.root,'resume');assert.notEqual((await c.exited)[0],0);const out=JSON.parse(c.output().stderr);assert.equal(out.credentialCalls,0);assert.match(out.error,/WORKFLOW_LAUNCH_UNCONFIRMED/);assert.deepEqual(await record(f.root),before);}finally{await cleanup(f.root);}
});
for (const [operation, acquisitions] of [['reject', 0], ['reject-complete', 1]] as const) test(`Agent credential ${operation} CAS failure blocks execution and leaves source lease available`,{skip:!enabled,timeout:60000},async()=>{
 const f=await setup();try{const c=child(f.root,operation,'a:credential');assert.notEqual((await c.exited)[0],0);const out=JSON.parse(c.output().stderr);assert.equal(out.credentialCalls,acquisitions);const current:any=(await record(f.root)).content;assert.equal(current.attempts[0].phases.length,acquisitions+1);assert.equal(current.attempts[0].phases[0].status,'completed');const lease=await f.source.acquire(credential);await lease.release();}finally{await cleanup(f.root);}
});
test('Agent file receipt restoration rejects identity, predecessor, files and installed evidence tampering',{skip:!enabled,timeout:100000},async()=>{
 const f=await setup();try{const normal=await finish(child(f.root,'normal'));assert.equal(normal.result.status,'succeeded');const original:any=(await record(f.root)).content;
 assert.equal(await readFile(join(f.root,'source/numbers.json'),'utf8'),'{"numbers":[1,2,3]}');assert.ok(!JSON.stringify(original).includes('fixture-deepseek-key'));
 const mutate=[(r:any)=>r.agent.identity.runId='foreign',(r:any)=>r.agent.harness='other',(r:any)=>r.agent.version='wrong',(r:any)=>r.agent.imageId='sha256:'+'0'.repeat(64),(r:any)=>r.agent.input.files[0].sha256='0'.repeat(64),(r:any)=>r.agent.output.files[0].sha256='0'.repeat(64),(r:any)=>r.agent.predecessor='receipt-1',(r:any)=>r.predecessor={fileRef:randomUUID()},(r:any)=>r.script={},(r:any)=>r.agent.extra=true];
 for(const change of mutate){const changed=structuredClone(original);change(changed.values[1].saved.receipt);const db=await SqliteRunRecordStore.open(join(f.root,'db'));try{const current=(await db.read('run'))!;await db.compareAndSwap('run',current.revision,changed);}finally{db.close();}const before=await record(f.root),c=child(f.root,'load');assert.notEqual((await c.exited)[0],0);assert.equal(JSON.parse(c.output().stderr).credentialCalls,0);assert.deepEqual(await record(f.root),before);}
 }finally{await cleanup(f.root);}
});

test('failed persistent Agent can retry cleanup after its phase port closes without upgrading the result', {skip:!enabled,timeout:60000},async()=>{
 const f=await setup();try{
   const result=await finish(child(f.root,'failure')); assert.equal(result.result.status,'failed');assert.deepEqual(result.calls,['a','b']);
   assert.equal(result.result.lastAccepted.node,'a');await assert.rejects(readdir(join(f.root,'driver-inputs')),{code:'ENOENT'});assert.deepEqual(await readdir(join(f.root,'attempts')),[]);
   const saved:any=(await record(f.root)).content;assert.equal(saved.snapshot.status,'failed');assert.equal(saved.attempts[1].phases.at(-1).status,'active');
   const loaded=await finish(child(f.root,'load','failure'));assert.equal(loaded.checkpoint.snapshot.status,'failed');assert.equal(loaded.credentialCalls,0);
 }finally{await cleanup(f.root);}
});

const queueConfiguration={roles:{writer:1},credentials:[{identity:credential,capacity:1}],workflows:{agents:Object.fromEntries(['a','b'].map(node=>[node,{role:'writer',capability:'agent',harness:'deepseek',credential}]))}};
test('queued actual Agent waits for a held credential without an Attempt and then executes only one node',{skip:!enabled,timeout:60000},async()=>{
 const f=await setup();try{
 await finish(child(f.root,'queue-prepare'));
 const lease=await f.source.acquireManagement(credential);
 try{const r=await finish(child(f.root,'queue-once'));assert.equal(r.result.waiting,'CREDENTIAL_SOURCE_BUSY');assert.equal(r.result.error,null);assert.equal(r.record.content.checkpoint.attempts.length,0);assert.deepEqual(r.calls,[]);assert.equal(r.credentialCalls,0);assert.equal(r.tasks[0].owner,null);}finally{await lease.release();}
 await new Promise(r=>setTimeout(r,1050));const a=await finish(child(f.root,'queue-once'));assert.equal(a.result.error,null);assert.equal(a.result.snapshot.steps.length,1);assert.deepEqual(a.calls,['a']);
 const b=await finish(child(f.root,'queue-once'));assert.equal(b.result.error,null);assert.equal(b.result.snapshot.status,'succeeded');assert.deepEqual(b.calls,['b']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
for(const stage of ['version','execution'])test(`queued actual Agent recovers a Worker killed during ${stage}, sealing old credential admission`,{skip:!enabled,timeout:70000},async()=>{
 const f=await setup();let db:SqliteRunRecordStore|undefined;try{
 await finish(child(f.root,'queue-prepare'));await pause(f.root,'queue-pause',stage);await new Promise(r=>setTimeout(r,1050));
 const r=await finish(child(f.root,'queue-once'));assert.equal(r.result.error,null);assert.equal(r.result.snapshot.steps.length,1);assert.equal(r.result.snapshot.steps[0].result.identity.attemptNumber,2);
 const token=r.tasks[0].admissionTokens[0];await assert.rejects(f.source.acquireAdmission(credential,token),/ADMISSION_CLOSED/);
 const b=await finish(child(f.root,'queue-once'));assert.equal(b.result.snapshot.status,'succeeded');
 }finally{
  db=await SqliteRunRecordStore.open(join(f.root,'db'));const {PersistentNodeQueue}=await import('@agentflow/integrations');const queue=new PersistentNodeQueue(db,queueConfiguration);const row:any=await queue.records().read('run'),saved=row?.content.checkpoint??row?.content;
  for(const a of saved?.attempts??[])for(const p of a.phases??[])if(p.resource){const id=p.resource.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}
  db.close();await rm(f.root,{recursive:true,force:true});
 }
});

for(const provider of ['codex','claude'])test(`queued ${provider} subscription transfers the reservation to Runner and recovers an interrupted Worker`,{skip:!enabled,timeout:70000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'af-queue-subscription-'));await mkdir(join(root,'source'));await writeFile(join(root,'source/numbers.json'),'{"numbers":[1,2,3]}');
 const identity={credentialRef:'fixture',service:provider==='codex'?'openai':'anthropic',method:'subscription'};
 const source=new FileCredentialStore(join(root,'credentials'),[provider==='codex'?new CodexSubscriptionCodec():new ClaudeSubscriptionCodec()]);
 const auth=JSON.stringify(provider==='codex'?{auth_mode:'chatgpt',tokens:{id_token:'fixture-id',access_token:'fixture-original',refresh_token:'fixture-refresh',account_id:'fixture-account'}}:{claudeAiOauth:{accessToken:'fixture-original',refreshToken:'fixture-refresh',expiresAt:2000000000000,scopes:['user:inference']}});
 await source.configure(identity,{content:auth});
 let db:SqliteRunRecordStore|undefined;
 try{
  await finish(child(root,'queue-prepare','',provider));await pause(root,'queue-pause','execution',provider);
  await assert.rejects(source.acquire(identity),/CREDENTIAL_BUSY/);await new Promise(r=>setTimeout(r,1050));
  const resumed=await finish(child(root,'queue-once','',provider));assert.equal(resumed.result.error,null);assert.equal(resumed.result.snapshot.steps[0].result.identity.attemptNumber,2);
  assert.equal((await source.inspect(identity))!.revision,2);await assert.rejects(source.acquireAdmission(identity,resumed.tasks[0].admissionTokens[0]),/ADMISSION_CLOSED/);
  const second=await finish(child(root,'queue-once','',provider));assert.equal(second.result.error,null);assert.equal(second.result.snapshot.status,'succeeded');
 }finally{
  db=await SqliteRunRecordStore.open(join(root,'db'));const {PersistentNodeQueue}=await import('@agentflow/integrations');
  const config=structuredClone(queueConfiguration);config.credentials[0]!.identity=identity;for(const node of Object.values(config.workflows.agents)){node.credential=identity;node.harness=provider;}
  const queue=new PersistentNodeQueue(db,config),row:any=await queue.records().read('run'),saved=row?.content.checkpoint??row?.content;
  for(const a of saved?.attempts??[])for(const p of a.phases??[])if(p.resource){const id=p.resource.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}
  db.close();await rm(root,{recursive:true,force:true});
 }
});

test('queued actual Agent retry releases source, preserves A and uses a fresh Attempt for B',{skip:!enabled,timeout:70000},async()=>{
 const f=await setup();try{
  await finish(child(f.root,'queue-prepare','retry'));const a=await finish(child(f.root,'queue-once','retry'));assert.equal(a.result.snapshot.steps.length,1);
  const first=await finish(child(f.root,'queue-once','retry'));assert.equal(first.result.error,null);assert.equal(first.result.waiting,'RETRY_WAIT');assert.equal(first.result.snapshot.retry.attemptNumber,1);
  assert.deepEqual(first.result.snapshot.steps,a.result.snapshot.steps);assert.deepEqual(await readdir(join(f.root,'attempts')),[]);
  const lease=await f.source.acquireManagement(credential);await lease.release();
  const second=await finish(child(f.root,'queue-once','retry'));assert.equal(second.result.error,null);assert.equal(second.result.snapshot.status,'failed');
  assert.equal(second.record.content.attempts.length,3);assert.equal(second.record.content.attempts[2].identity.attemptNumber,2);assert.equal(second.record.content.attempts[2].identity.nodeTaskId,'task-2');
  assert.deepEqual(second.result.snapshot.steps[0],a.result.snapshot.steps[0]);assert.equal(second.record.content.values.length,2);assert.deepEqual(await readdir(join(f.root,'attempts')),[]);
  assert.equal((await finish(child(f.root,'queue-once','retry'))).result,null);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
