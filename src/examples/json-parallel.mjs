import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ContractRegistry,ComponentRegistry,FunctionRegistry,JsonFunctionWorkflowCatalog,ParallelWorkflowCatalog,compileWorkflow,WorkflowRuntime,NodeWorker,loadWorkflowCheckpoint} from '@agentflow/engine';
import {SqliteRunRecordStore,PersistentNodeQueue,systemClock} from '@agentflow/integrations';

const kind=process.argv[2]??'map';
if(!['map','fork'].includes(kind))throw new Error('Use map or fork');
const root=await mkdtemp(join(tmpdir(),'agentflow-parallel-demo-'));
const records=await SqliteRunRecordStore.open(join(root,'queue'));
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
 const flow=compileWorkflow({id:'demo',start:'batch',maxSteps:1,input:{kind:'json',id:kind==='map'?'items':'item'},outcomes:{done:{kind:'json',id:'joined'}},nodes:{batch:{component:'batch'}},routes:[{from:'batch',outcome:'done',to:{end:'done'}}]},parallel);
 const configuration={roles:{coordinator:1,compute:2},credentials:[],workflows:{demo:{batch:{role:'coordinator',capability:'json'}},...Object.fromEntries(parallel.childWorkflows().map(child=>[child.definition.id,{unit:{role:'compute',capability:'json'}}]))}};
 const queue=new PersistentNodeQueue(records,configuration);
 const input=kind==='map'?[{id:'a',value:1},{id:'b',value:2},{id:'c',value:3}]:{id:'request',value:7};
 await new WorkflowRuntime().preparePersisted(flow,'example',input,queue.records());
 const host={open:async(runId,store)=>{
  const row=await store.read(runId),checkpoint=row.content.checkpoint??row.content;
  const compiled=checkpoint.snapshot.workflowId==='demo'?flow:parallel.childWorkflow(checkpoint.snapshot.workflowId);
  if(!compiled)throw new Error('Unknown installed workflow');
  return {compiled,runtime:new WorkflowRuntime()};
 }};
 const worker=id=>new NodeWorker(queue,host,systemClock,id,['json'],300);
 await worker('coordinator').runOnce();
 const runs=await Promise.all([worker('first').runUntilIdle(),worker('second').runUntilIdle()]);
 if(runs.flat().some(result=>result.error))throw new Error('Worker failed');
 const loaded=await loadWorkflowCheckpoint(flow,'example',queue.records());
 try {
  if(loaded.checkpoint.snapshot.status!=='succeeded')throw new Error('Example did not finish');
  console.log(JSON.stringify(loaded.checkpoint.snapshot.lastAccepted.result.output,null,2));
 } finally {await loaded.dispose();}
} finally {records.close();await rm(root,{recursive:true,force:true});}
