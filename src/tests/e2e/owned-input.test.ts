import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner, ContractRegistry, FileContractRegistry } from '@agentflow/engine';
import type { RunnerResourceCheckpoint, RunnerInputMaterializer } from '@agentflow/engine';
import { DockerBackend, FileArtifactStore, systemClock } from '@agentflow/integrations';
const enabled=process.env['AGENTFLOW_DOCKER_TESTS']==='1';
const identity={runId:'input',nodeTaskId:'task',attemptId:'attempt',attemptNumber:1};
async function setup(materialize?: (path:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'af-owned-input-')),source=join(root,'source');await mkdir(source);await writeFile(join(source,'input.txt'),'original');
 const backend=new DockerBackend({workspaceRoot:join(root,'attempts'),image:'alpine:3'},undefined,undefined,materialize?{materialize}:undefined);
 return{root,source,backend,runner:new Runner(backend,systemClock),close:()=>rm(root,{recursive:true,force:true})};
}
test('artifact materialization stays under the persisted Runner resource and preserves writable isolation',{skip:!enabled,timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'af-owned-artifact-'));let record:RunnerResourceCheckpoint|undefined;const events:string[]=[];
 try{
  const source=join(root,'source');await mkdir(source);await writeFile(join(source,'input.txt'),'original');
  const contracts=new FileContractRegistry(new ContractRegistry());contracts.register('input',{rules:[{id:'text',kind:'file',match:'input.txt',minCount:1,maxCount:1,mediaTypes:['text/plain'],maxBytes:1024}],maxFiles:1,maxTotalBytes:1024,unmatched:'reject'});
  const artifacts=new FileArtifactStore(join(root,'artifacts'),contracts),manifest=await artifacts.capture(source,'input');
  const input:RunnerInputMaterializer={async materialize(destination){assert.equal(events.at(-1),'prepare_pending');assert.equal(dirname(destination),(record!.backend as any).directory);await artifacts.materialize(manifest.id,destination);}};
  const backend=new DockerBackend({workspaceRoot:join(root,'attempts'),image:'alpine:3'},undefined,undefined,input),runner=new Runner(backend,systemClock);
  input.materialize=async()=>{throw new Error('mutated method must not replace installed materializer');};
  const result=await runner.run({identity,inputSource:null,timeoutMs:5000,invocation:{argv:['sh','-c','printf changed > /task/input/input.txt; cat /task/input/input.txt']}},undefined,{save:async r=>{record=r;events.push('saved');},launch:async state=>{events.push(state);}});
  assert.equal(result.phase,'exited');assert.equal(result.exitCode,0);assert.equal(await readFile(result.capture!.stdout.path,'utf8'),'changed');assert.equal(await readFile(join(source,'input.txt'),'utf8'),'original');
  const directory=(record!.backend as any).directory;assert.ok(!(await readdir(directory)).includes('input-source'));assert.ok(!JSON.stringify(record).includes('materialize'));
  await runner.release(result.resource!);await assert.rejects(readdir(directory),{code:'ENOENT'});await artifacts.release(manifest.id);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('empty Runner input uses only the owned workspace',{skip:!enabled,timeout:30000},async()=>{
 const f=await setup();try{const result=await f.runner.run({identity,inputSource:null,timeoutMs:5000,invocation:{argv:['sh','-c','test -z "$(ls -A /task/input)" && touch /task/input/writable']}});assert.equal(result.exitCode,0);await f.runner.release(result.resource!);assert.deepEqual(await readdir(join(f.root,'attempts')),[]);assert.equal(await readFile(join(f.source,'input.txt'),'utf8'),'original');}finally{await f.close();}
});
for(const failure of ['partial','symlink','ambiguous']as const)test(`owned input ${failure} failure never starts and cleanup preserves unrelated files`,{skip:!enabled,timeout:30000},async()=>{
 let called=0;let source='';const f=await setup(async destination=>{called++;if(failure==='symlink'){await symlink(source,destination);return;}await mkdir(destination);await writeFile(join(destination,'partial'),'partial');throw new Error('interrupted materialization');});source=f.source;
 try{let record:RunnerResourceCheckpoint|undefined;const result=await f.runner.run({identity,inputSource:failure==='ambiguous'?source:null,timeoutMs:5000,invocation:{argv:['sh','-c','exit 99']}},undefined,{save:async r=>{record=r;},launch:async()=>{}});
  assert.equal(result.phase,'failed');assert.equal(result.exitCode,null);assert.ok(result.diagnostics.includes('PREPARE_FAILED'));assert.equal(called,failure==='ambiguous'?0:1);
  await f.runner.release(result.resource!);await assert.rejects(readdir((record!.backend as any).directory),{code:'ENOENT'});assert.equal(await readFile(join(source,'input.txt'),'utf8'),'original');
 }finally{await f.close();}
});
