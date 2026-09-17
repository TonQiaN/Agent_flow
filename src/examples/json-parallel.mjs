import {parallelDefinition} from './studio/parallel.mjs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ContractRegistry,ComponentRegistry,FunctionRegistry,JsonFunctionWorkflowCatalog,ParallelWorkflowCatalog,compileWorkflow,WorkflowRuntime,NodeWorker,loadWorkflowCheckpoint} from '@agentflow/engine';
import {SqliteRunRecordStore,PersistentNodeQueue,systemClock} from '@agentflow/integrations';

const kind=process.argv[2]??'map';
const runId=process.env.AGENTFLOW_STUDIO_RUN_ID??'example';
if(!['map','fork'].includes(kind))throw new Error('Use map or fork');
const keep=process.env.AGENTFLOW_HISTORY_DISABLED!=='1'||!!process.env.AGENTFLOW_STUDIO_RUN_ROOT;
const root=keep?(process.env.AGENTFLOW_STUDIO_RUN_ROOT??join(resolve(process.env.AGENTFLOW_STUDIO_DATA??'.local/studio'),'runs','cli-'+randomUUID())):await mkdtemp(join(tmpdir(),'agentflow-parallel-demo-'));
await mkdir(root,{recursive:true,mode:0o700});
if(keep&&!process.env.AGENTFLOW_STUDIO_RUN_ROOT)await writeFile(join(root,'meta.json'),JSON.stringify({id:root.split('/').at(-1),workflowId:'parallel-'+kind,title:'JSON '+kind,mainRunId:runId,createdAt:Date.now(),source:'cli'}),{mode:0o600});
const records=await SqliteRunRecordStore.open(join(root,'records'));
try {
 const contracts=new ContractRegistry();
 contracts.register('item',{type:'object',properties:{id:{type:'string'},value:{type:'number'}},required:['id','value']});
 contracts.register('items',{type:'array',items:{type:'object'}});
 contracts.register('joined',{type:'object',properties:{[kind==='map'?'items':'branches']:{type:'array'}},required:[kind==='map'?'items':'branches']});
 const components=new ComponentRegistry(contracts),functions=new FunctionRegistry();
 for(const [id,factor] of [['double',2],['triple',3]]) {
  components.register({id,kind:'transform',implementation:id,inputContract:'item',outcomes:{ok:'item'}});
  functions.registerDeterministic(id,{revision:'demo-v1',run:async(input,config)=>{
   await new Promise(resolve=>setTimeout(resolve,input.id==='a'?50:5));
   return {outcome:'ok',output:{id:input.id,value:input.value*config.factor}};
  }},{factor});
 }
 const source=new JsonFunctionWorkflowCatalog(contracts,components,functions);
 const parallel=new ParallelWorkflowCatalog(contracts,source);
 const structure=kind==='map'?{component:'double',itemId:'id'}:{branches:{zeta:{component:'triple'},alpha:{component:'double'}}};
 parallel.register('batch',{kind,inputContract:kind==='map'?'items':'item',outputContract:'joined',outcome:'done',maxConcurrency:2,failurePolicy:'wait-all',...structure});
 const flow=compileWorkflow(parallelDefinition(kind),parallel);
 const configuration={roles:{coordinator:1,compute:2},credentials:[],workflows:{demo:{batch:{role:'coordinator',capability:'json'}},...Object.fromEntries(parallel.childWorkflows().map(child=>[child.definition.id,{unit:{role:'compute',capability:'json'}}]))}};
 const queue=new PersistentNodeQueue(records,configuration);
 const input=kind==='map'?[{id:'a',value:1},{id:'b',value:2},{id:'c',value:3}]:{id:'request',value:7};
 await new WorkflowRuntime().preparePersisted(flow,runId,input,queue.records());
 const host={open:async(runId,store)=>{
  const row=await store.read(runId),checkpoint=row.content.checkpoint??row.content;
  const compiled=checkpoint.snapshot.workflowId==='demo'?flow:parallel.childWorkflow(checkpoint.snapshot.workflowId);
  if(!compiled)throw new Error('Unknown installed workflow');
  return {compiled,runtime:new WorkflowRuntime()};
 }};
 // Use the Worker default lease: this runnable example is not a lease-expiry test.
 const worker=id=>new NodeWorker(queue,host,systemClock,id,['json']);
 const check=result=>{if(result?.error)throw new Error(`Worker ${result.claim.worker} (${result.claim.node}) failed: ${result.error}`);};
 check(await worker('coordinator').runOnce());
 const runs=await Promise.all([worker('first').runUntilIdle(),worker('second').runUntilIdle()]);
 for(const result of runs.flat())check(result);
 const loaded=await loadWorkflowCheckpoint(flow,runId,queue.records());
 try {
  if(loaded.checkpoint.snapshot.status!=='succeeded')throw new Error('Example did not finish');
  console.log(JSON.stringify(loaded.checkpoint.snapshot.lastAccepted.result.output,null,2));
 } finally {await loaded.dispose();}
} finally {records.close();if(!keep)await rm(root,{recursive:true,force:true});}
