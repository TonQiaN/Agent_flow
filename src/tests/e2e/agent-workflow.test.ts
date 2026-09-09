import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteRunRecordStore, FileCredentialStore, DeepSeekApiKeyCodec } from '@agentflow/integrations';
import { docker } from '../../packages/integrations/docker/process.js';
const enabled=process.env['AGENTFLOW_EGRESS_TESTS']==='1',image=`agentflow-test/agent-workflow:${randomUUID()}`;
const credential={credentialRef:'fixture',service:'deepseek',method:'api-key'};
let build:string|undefined,assetsPath:string;
before(async()=>{
 if(!enabled)return;build=await mkdtemp(join(tmpdir(),'af-agent-workflow-build-'));assetsPath=join(build,'assets.json');
 await writeFile(assetsPath,execFileSync(process.execPath,['src/apps/deepseek-tools/export-assets.mjs']));
 await writeFile(join(build,'Dockerfile'),'FROM node:22-bookworm-slim\nCOPY --chmod=755 dsh /usr/local/bin/dsh\nCOPY package.json /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json\n');
 const cli=(await readFile(new URL('../fixtures/deepseek-protocol.cjs',import.meta.url),'utf8')).replace("const source = '/task/input/numbers.json', numbers = JSON.parse(fs.readFileSync(source)).numbers;","const source = fs.existsSync('/task/input/numbers.json') ? '/task/input/numbers.json' : '/task/input/answer.json'; const value = JSON.parse(fs.readFileSync(source)); const numbers = value.numbers ?? [value.sum];");
 await writeFile(join(build,'dsh'),cli);await writeFile(join(build,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.1.1-rc.2'}));
 execFileSync('docker',['build','--network','none','--pull=false','--tag',image,build],{stdio:'pipe',timeout:60000});
});
after(async()=>{if(build){await docker(['image','rm',image]).catch(()=>{});await rm(build,{recursive:true,force:true});}});
function child(root:string,operation:string,stage=''){
 const process=fork(new URL('../fixtures/agent-workflow.mjs',import.meta.url),[root,operation,stage,image,assetsPath],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});
 let stdout='',stderr='';process.stdout!.on('data',b=>stdout+=b);process.stderr!.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>process.kill('SIGKILL'),45000),exited=once(process,'exit').finally(()=>clearTimeout(timer));return{process,exited,output:()=>({stdout,stderr})};
}
async function finish(c:ReturnType<typeof child>){assert.equal((await c.exited)[0],0,c.output().stderr);return JSON.parse(c.output().stdout);}
async function pause(root:string,operation:string,stage:string){const c=child(root,operation,stage);try{return(await Promise.race([once(c.process,'message'),c.exited.then(()=>{throw new Error(c.output().stderr||c.output().stdout||'no pause');})]))[0];}finally{if(c.process.exitCode===null&&c.process.signalCode===null){c.process.kill('SIGKILL');await c.exited;}}}
async function setup(){const root=await mkdtemp(join(tmpdir(),'af-agent-workflow-'));await mkdir(join(root,'source'));await writeFile(join(root,'source/numbers.json'),'{"numbers":[1,2,3]}');const source=new FileCredentialStore(join(root,'credentials'),[new DeepSeekApiKeyCodec()]);await source.configure(credential,{content:JSON.stringify({schema:'agentflow-deepseek-key/v1',api_key:'fixture-deepseek-key'})});return{root,source};}
async function record(root:string){const db=await SqliteRunRecordStore.open(join(root,'db'));try{return(await db.read('run'))!;}finally{db.close();}}
async function cleanup(root:string){const saved:any=(await record(root))?.content,c=saved?.checkpoint??saved;for(const a of c?.attempts??[])for(const p of a.phases??[])if(p.resource){const id=p.resource.resource.id;await docker(['rm','-f',id,`${id}-proxy`]).catch(()=>{});for(const suffix of ['internal','external'])await docker(['network','rm',`${id}-${suffix}`]).catch(()=>{});}await rm(root,{recursive:true,force:true});}
for(const [stage,interruptions]of [['a:version',1],['b:execution',1],['b:execution',2]]as const)test(`actual Agent Workflow resumes after ${stage}/${interruptions}`,{skip:!enabled,timeout:100000},async()=>{
 const f=await setup();try{
 const first=await pause(f.root,'run',stage);assert.equal(first.credentialCalls,stage==='a:version'?0:2);
 if(interruptions===2)assert.equal((await pause(f.root,'resume-pause',stage)).identity.attemptNumber,2);
 const prior:any=(await record(f.root)).content,ids=prior.attempts.flatMap((a:any)=>(a.phases??[]).flatMap((p:any)=>p.resource?[p.resource.resource.id]:[]));
 await rm(join(f.root,'source'),{recursive:true});const result=await finish(child(f.root,'resume'));
 assert.equal(result.result.status,'succeeded');assert.deepEqual(result.calls,stage==='a:version'?['a','b']:['b']);assert.equal(result.credentialCalls,result.calls.length);
 const last=result.result.lastAccepted;assert.equal(last.result.identity.attemptNumber,stage==='a:version'?1:interruptions+1);
 assert.deepEqual(JSON.parse(await readFile(join(f.root,'result-output/answer.json'),'utf8')),{sum:6});
 for(const id of ids)assert.equal(await docker(['container','ls','-a','--filter',`name=^/${id}(-proxy)?$`,'--format','{{.ID}}']),'');
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
   assert.equal(result.result.lastAccepted.node,'a');assert.deepEqual(await readdir(join(f.root,'driver-inputs')),[]);assert.deepEqual(await readdir(join(f.root,'attempts')),[]);
   const saved:any=(await record(f.root)).content;assert.equal(saved.snapshot.status,'failed');assert.equal(saved.attempts[1].phases.at(-1).status,'active');
   const loaded=await finish(child(f.root,'load','failure'));assert.equal(loaded.checkpoint.snapshot.status,'failed');assert.equal(loaded.credentialCalls,0);
 }finally{await cleanup(f.root);}
});
