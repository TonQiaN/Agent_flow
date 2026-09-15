import { join } from 'node:path';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { SqliteRunRecordStore } from '@agentflow/integrations';
const [root, mode, variant='same'] = process.argv.slice(2);
const records=await SqliteRunRecordStore.open(join(root,'runs'));
let readOnce=false, calls=[], paused=false;
const pause=async point=>{
 if(paused || ![point,`hold-${point}`,`recover-${point}`].includes(mode))return;paused=true;
 if(mode.startsWith('hold-')){process.send({point});await new Promise(r=>process.once('message',r));}
 else{process.send({point},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});}
};
const store={create:records.create.bind(records),compareAndSwap:records.compareAndSwap.bind(records),read:async(...args)=>{
 const record=await records.read(...args);
 if(mode==='recover-compete'&&!readOnce){readOnce=true;process.send({point:'read'});await new Promise(r=>process.once('message',r));}
 return record;
}};
const contracts=new ContractRegistry();contracts.register('value',{type:'integer'});
const components=new ComponentRegistry(contracts), functions=new FunctionRegistry();
components.register({id:'a',kind:'gate',implementation:'gate',inputContract:'value',outcomes:{pass:'value',reject:'value'}});
components.register({id:'b',kind:'transform',implementation:'increment',inputContract:'value',outcomes:{done:'value'}});
functions.registerDeterministic('gate',{revision:'gate-v1',run:(input,config)=>({outcome:input>=config.minimum?'pass':'reject',output:input})},{minimum:0});
functions.registerDeterministic('increment',{revision:variant==='revision'?'increment-v2':'increment-v1',run:(input,config)=>({outcome:'done',output:input+config.amount})},{amount:variant==='config'?2:1});
const catalog=new JsonFunctionWorkflowCatalog(contracts,components,functions),execute=catalog.execute.bind(catalog);
catalog.execute=async(...args)=>{
 const [component,,identity]=args;calls.push({component:component.id,identity});
 if(component.id==='b')await pause('before-call');const result=await execute(...args);
 if(component.id==='b')await pause('after-call');return result;
};
const value={kind:'json',id:'value'};
const flow=compileWorkflow({id:'functions',start:'a',input:value,outcomes:{done:value,rejected:value},maxSteps:2,nodes:{a:{component:'a'},b:{component:'b'}},routes:[
 {from:'a',outcome:'pass',to:{node:'b'}},{from:'a',outcome:'reject',to:{end:'rejected'}},{from:'b',outcome:'done',to:{end:'done'}}]},catalog);
let loaded,recovery,run;
try{
 let result;
 if(mode==='load'){loaded=await loadWorkflowCheckpoint(flow,'run',store);result=loaded.checkpoint.snapshot;}
 else if(mode.startsWith('recover')){recovery=await claimWorkflowRecovery(flow,'run',store);await recovery.cleanup();run=await new WorkflowRuntime().resumePersisted(recovery);result=await run.completion;}
 else {run=await new WorkflowRuntime().startPersisted(flow,'run',4,store);result=await run.completion;}
 process.send({result,calls,record:await records.read('run')});
}catch(error){process.send({error:error.code??'FAILED',calls,record:await records.read('run')});}
finally{await run?.dispose?.();await recovery?.dispose();await loaded?.dispose();records.close();process.disconnect?.();}
