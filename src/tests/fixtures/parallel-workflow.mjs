import {ContractRegistry,ComponentRegistry,FunctionRegistry,JsonFunctionWorkflowCatalog,ParallelWorkflowCatalog,compileWorkflow,WorkflowRuntime} from '@agentflow/engine';
export function application({kind='map',maxConcurrency=2,roleCapacity=3,credentialCapacity=null,observe=async()=>{},badJoin=false,retry={maxAttempts:3,on:['execution_failure','interrupted'],delayMs:10},clock}={}){
 const contracts=new ContractRegistry();contracts.register('item',{type:'object',properties:{id:{type:'string'},value:{type:'integer'}},required:['id','value']});contracts.register('items',{type:'array',items:{type:'object'}});
 contracts.register('joined',{type:'object',properties:{[kind==='map'?'items':'branches']:{type:'array',...(badJoin?{minItems:999}:{})}},required:[kind==='map'?'items':'branches'],additionalProperties:false});
 const components=new ComponentRegistry(contracts),functions=new FunctionRegistry();
 for(const id of ['extract','check','finish']){
  const ref=id==='finish'?'joined':'item';components.register({id,kind:'transform',implementation:id,inputContract:ref,outcomes:{ok:ref}});
  functions.registerDeterministic(id,{revision:'parallel-test-v1',run:async input=>{const output=structuredClone(input);if(id!=='finish')input.value=999;return{outcome:'ok',output};}});
 }
 const source=new JsonFunctionWorkflowCatalog(contracts,components,functions),execute=source.execute.bind(source);
 source.execute=async(...args)=>{const code=await observe({component:args[0].id,input:structuredClone(args[1]),identity:args[2],cancel:args[3]});if(typeof code==='string')return{componentId:args[0].id,identity:args[2],status:'failed',code,stopped:true,issues:[]};return execute(...args);};
 const parallel=new ParallelWorkflowCatalog(contracts,source);
 const unitRetry=retry?{retry}:{};
 const shape=kind==='map'?{component:'extract',itemId:'id',...unitRetry}:{branches:{zeta:{component:'extract',...unitRetry},alpha:{component:'check',...unitRetry}}};
 parallel.register('scatter',{kind,inputContract:kind==='map'?'items':'item',outputContract:'joined',outcome:'joined',maxConcurrency,failurePolicy:'wait-all',...shape});
 const compiled=compileWorkflow({id:'parallel',start:'scatter',maxSteps:2,input:{kind:'json',id:kind==='map'?'items':'item'},outcomes:{done:{kind:'json',id:'joined'}},nodes:{scatter:{component:'scatter'},after:{component:'finish'}},routes:[{from:'scatter',outcome:'joined',to:{node:'after'}},{from:'after',outcome:'ok',to:{end:'done'}}]},parallel);
 const credential={credentialRef:'parallel-fixture',service:'fixture',method:'api-key'};
 const unitRequirement={role:'unit',capability:'json',...(credentialCapacity?{credential}:{})};
 const configuration={roles:{coordinator:1,unit:roleCapacity},credentials:credentialCapacity?[{identity:credential,capacity:credentialCapacity}]:[],workflows:{parallel:{scatter:{role:'coordinator',capability:'json'},after:{role:'coordinator',capability:'json'}},...Object.fromEntries(parallel.childWorkflows().map(c=>[c.definition.id,{unit:unitRequirement}]))}};
 return {compiled,configuration,parallel,contracts,source,components,functions,runtime:new WorkflowRuntime(clock),async open(runId,records){const row=await records.read(runId),c=row.content.checkpoint??row.content;return {compiled:c.snapshot.workflowId==='parallel'?compiled:parallel.childWorkflow(c.snapshot.workflowId),runtime:new WorkflowRuntime(clock)};}};
}
