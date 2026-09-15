import { join } from 'node:path';
import { ContractRegistry, FileContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { FileArtifactArchive, FileArtifactStore, FileWorkflowCatalog, FileJsonWorkflowCatalog, SqliteRunRecordStore } from '@agentflow/integrations';
const [root,mode,variant='same']=process.argv.slice(2);
const records=await SqliteRunRecordStore.open(join(root,'runs'));
const json=new ContractRegistry();json.register('value',{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false});
const contracts=new FileContractRegistry(json);contracts.register('files',{rules:[{id:'answer',kind:'file',match:'answer.json',minCount:1,maxCount:1,maxBytes:100,mediaTypes:['application/json'],jsonContract:'value'}],maxFiles:1,maxTotalBytes:100,unmatched:'reject'});
const files=new FileWorkflowCatalog(contracts,new FileArtifactStore(join(root,'temporary'),contracts),join(root,'nodes'),new FileArtifactArchive(join(root,'archive'),contracts));
const bridge=new FileJsonWorkflowCatalog(files,json,join(root,'transforms'));
const component={id:'project',implementation:'read-json',kind:'transform',inputContract:'files',outcomes:{done:'value'}};
if(variant==='ordinary')bridge.register(component,async()=>({outcome:'done',output:{value:7}}));
else bridge.registerJsonFile(component,{path:variant==='path'?'other.json':'answer.json',outcome:'done',maxBytes:variant==='limit'?50:100});
const functions=new FunctionRegistry(),components=new ComponentRegistry(json);
components.register({id:'finish',implementation:'finish',kind:'transform',inputContract:'value',outcomes:{done:'value'}});
functions.registerDeterministic('finish',{revision:'v1',run:input=>({outcome:'done',output:input})});
const finish=new JsonFunctionWorkflowCatalog(json,components,functions);
let paused=false,calls=[], readOnce=false;
const pause=async point=>{if(paused||![point,`hold-${point}`,`recover-${point}`].includes(mode))return;paused=true;
 if(mode.startsWith('hold-')){process.send({point});await new Promise(r=>process.once('message',r));}
 else {process.send({point},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});}};
const execute=bridge.execute.bind(bridge);bridge.execute=async(...args)=>{calls.push({component:args[0].id,identity:args[2]});await pause('before-read');const result=await execute(...args);await pause('after-read');return result;};
if(variant==='reject-final')finish.check=()=>[{contractId:'value',path:'',rule:'',code:'injected'}];
const end=finish.execute.bind(finish);finish.execute=async(...args)=>{calls.push({component:args[0].id,identity:args[2]});await pause('after-accepted');return end(...args);};
const store={create:records.create.bind(records),compareAndSwap:records.compareAndSwap.bind(records),read:async(...args)=>{const r=await records.read(...args);if(mode==='recover-compete'&&!readOnce){readOnce=true;process.send({point:'read'});await new Promise(resolve=>process.once('message',resolve));}return r;}};
const flow=compileWorkflow({id:'file-json',start:'project',input:{kind:'files',id:'files'},outcomes:{done:{kind:'json',id:'value'}},maxSteps:2,nodes:{project:{component:'project'},finish:{component:'finish'}},routes:[{from:'project',outcome:'done',to:{node:'finish'}},{from:'finish',outcome:'done',to:{end:'done'}}]}, {resolve:id=>(id==='project'?bridge:finish).resolve(id)});
let loaded,recovery,run;
try{
 let result;
 if(mode==='load'){loaded=await loadWorkflowCheckpoint(flow,'run',store);result=loaded.checkpoint.snapshot;}
 else if(mode.startsWith('recover')){recovery=await claimWorkflowRecovery(flow,'run',store);await recovery.cleanup();run=await new WorkflowRuntime().resumePersisted(recovery);result=await run.completion;}
 else {const input=await files.prepareInput('run',join(root,'source'),'files');run=await new WorkflowRuntime().startPersisted(flow,'run',input,store);result=await run.completion;}
 const projection=result.steps.find(s=>s.result.componentId==='project'&&s.result.status==='accepted')?.result;
 const receipt=projection?bridge.receipt(projection.identity):null;
 const matches=projection?bridge.matches(projection.identity,projection.output):false;
 const record=await records.read('run');await loaded?.dispose();loaded=undefined;await recovery?.dispose();recovery=undefined;await run?.dispose?.();
 process.send({result,calls,receipt,matches,afterDispose:projection?bridge.matches(projection.identity,projection.output):false,record});
}catch(error){const row=await records.read('run'),p=row?.content.snapshot?.steps?.[0]?.result;process.send({error:error.code??'FAILED',calls,record:row,residual:p?bridge.matches(p.identity,p.output):false});}
finally{await run?.dispose?.();await recovery?.dispose();await loaded?.dispose();records.close();process.disconnect?.();}
