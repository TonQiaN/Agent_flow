import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {JsonValue,ComponentDefinition,ExecutionIdentity} from '@agentflow/domain';
import {ContractRegistry,ParallelWorkflowCatalog,WorkflowRuntime,compileWorkflow,ScriptExecutor,NodeWorker,loadWorkflowCheckpoint} from '@agentflow/engine';
import type {WorkflowNodeExecutor,ScriptAttempt,WorkflowNodeResult} from '@agentflow/engine';
import {DockerBackend,SqliteRunRecordStore,PersistentNodeQueue,systemClock} from '@agentflow/integrations';
const enabled=process.env['AGENTFLOW_DOCKER_TESTS']==='1';
test('parallel JSON components use distinct real Runner workspaces and logical outputs with stable input order',{skip:!enabled,timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'af-parallel-json-script-')),db=await SqliteRunRecordStore.open(join(root,'db'));
 try{
  const contracts=new ContractRegistry();contracts.register('item',{type:'object',properties:{id:{type:'string'},value:{type:'integer'},delay:{type:'integer'}},required:['id','value','delay']});contracts.register('items',{type:'array'});contracts.register('joined',{type:'object',properties:{items:{type:'array'}},required:['items']});
  const definition={argv:['node','-e',"const fs=require('node:fs');const value=JSON.parse(fs.readFileSync('/task/input/value.json'));setTimeout(()=>{if(fs.existsSync('/task/outputs/value.json'))process.exit(2);fs.writeFileSync('/task/input/value.json','changed');fs.writeFileSync('/task/outputs/value.json',JSON.stringify(value));console.log(JSON.stringify({schema:'agentflow-script-result/v1',outcome:'ok'}));},value.delay)"],timeoutMs:10000,outcomes:['ok']};
  const script=new ScriptExecutor(new DockerBackend({workspaceRoot:join(root,'attempts'),image:'node:22-bookworm-slim'}),systemClock,{read:async f=>readFile(f.path,'utf8')});
  const component:ComponentDefinition={id:'json-script',kind:'transform',implementation:'json-script',inputContract:'item',outcomes:{ok:'item'}};const attempts=new Map<string,ScriptAttempt>(),sources:string[]=[];
  const executor:WorkflowNodeExecutor={validate(){},contract:id=>({kind:'json',id}),contractDefinition:id=>({kind:'json',id,schema:contracts.definition(id)}),check:(id,v)=>{const result=contracts.check(id,v);return result.valid?[]:result.issues.map(i=>({contractId:id,path:i.instancePath,rule:i.schemaPath,code:i.keyword}));},executionDefinition:async()=>({schema:'test-json-script/v1',script:await script.definitionSnapshot(definition)}),resourceDefinition:()=>script.resourceDefinition(),restoreResource:(_c,r)=>script.restoreResource(r),cleanupFailed:async i=>{await attempts.get(i.runId)?.releaseExecution();},
   execute:async(c,input,identity,cancel,persistence):Promise<WorkflowNodeResult>=>{
    const source=await mkdtemp(join(root,'input-'));sources.push(source);await writeFile(join(source,'value.json'),JSON.stringify(input));
    const attempt=await script.execute({identity,inputSource:source,definition},cancel,persistence);attempts.set(identity.runId,attempt);
    if(attempt.result.status==='failed')return{componentId:c.id,identity,status:'failed',code:attempt.result.code,stopped:attempt.stopped(),issues:[]};
    const output=JSON.parse(await readFile(join(attempt.executionFacts()!.capture!.outputsPath,'value.json'),'utf8')) as JsonValue;await attempt.releaseExecution();return{componentId:c.id,identity,status:'accepted',outcome:'ok',output};
   }};
  const catalog=new ParallelWorkflowCatalog(contracts,{resolve:()=>({component,executor})});catalog.register('scatter',{kind:'map',inputContract:'items',outputContract:'joined',component:'json-script',itemId:'id',outcome:'done',maxConcurrency:2,failurePolicy:'wait-all'});
  const flow=compileWorkflow({id:'scripts',start:'scatter',maxSteps:1,input:{kind:'json',id:'items'},outcomes:{done:{kind:'json',id:'joined'}},nodes:{scatter:{component:'scatter'}},routes:[{from:'scatter',outcome:'done',to:{end:'done'}}]},catalog);
  const config={roles:{coordinator:1,script:3},credentials:[],workflows:{scripts:{scatter:{role:'coordinator',capability:'json'}},...Object.fromEntries(catalog.childWorkflows().map(c=>[c.definition.id,{unit:{role:'script',capability:'docker'}}]))}};
  const queue=new PersistentNodeQueue(db,config),input=[{id:'slow',value:1,delay:300},{id:'fast',value:2,delay:10},{id:'last',value:3,delay:30}];
  await new WorkflowRuntime().preparePersisted(flow,'run',input,queue.records());let n=0;
  const worker=()=>new NodeWorker(queue,{open:async(runId,records)=>{const row=(await records.read(runId))!.content as any,c=row.checkpoint??row;return{compiled:c.snapshot.workflowId==='scripts'?flow:catalog.childWorkflow(c.snapshot.workflowId)!,runtime:new WorkflowRuntime()};}},systemClock,`w-${++n}`,['json','docker'],900);
  assert.equal((await worker().runOnce())!.waiting,'PARALLEL_WAIT');const first=await Promise.all([worker().runOnce(),worker().runOnce()]);assert.ok(first.every(r=>r?.error===null));await worker().runUntilIdle();
  const loaded=await loadWorkflowCheckpoint(flow,'run',queue.records());try{assert.equal(loaded.checkpoint.snapshot.status,'succeeded');assert.deepEqual((loaded.checkpoint.snapshot.lastAccepted!.result as any).output.items.map((i:any)=>i.output),input);
   const paths:string[]=[];for(const child of loaded.checkpoint.attempts[0]!.parallel!.children){const row:any=await queue.records().read(child.runId);paths.push(row.content.attempts[0].resource.backend.directory);}assert.equal(new Set(paths).size,3);
  }finally{await loaded.dispose();}
  const actual=await Promise.all(sources.map(async s=>JSON.parse(await readFile(join(s,'value.json'),'utf8'))));assert.deepEqual(actual.sort((a,b)=>a.value-b.value),input);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
