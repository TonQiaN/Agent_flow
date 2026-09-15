import { compileWorkflow, WorkflowRuntime } from '@agentflow/engine';
export const policy = {maxAttempts:3,on:['execution_failure','interrupted','timeout'],delayMs:1000};
export const configuration = {roles:{role:1},credentials:[],workflows:{retry:{a:{role:'role',capability:'json'},b:{role:'role',capability:'json'}}}};
export function application({clock, retry=policy, invoke=async ({identity}) => identity.attemptNumber < 3 ? 'IMPLEMENTATION_FAILED' : null, effect=false, checkRecovery=async()=>{}}={}) {
 const contract={kind:'json',id:'value'};
 const executor={validate(){},contract:()=>contract,contractDefinition:()=>({...contract,schema:{type:'object'}}),check:()=>[],executionDefinition:async()=>({schema:'retry-fixture/v1'}),checkRecovery,
 execute:async(component,input,identity,cancel)=>{
   const code=await invoke({component,input,identity,cancel});
   return code ? {status:'failed',componentId:component.id,identity,code,stopped:code!=='EFFECT_RESULT_UNKNOWN',issues:[]}
    :{status:'accepted',componentId:component.id,identity,outcome:'ok',output:input};
 }};
 const compiled=compileWorkflow({id:'retry',start:'a',maxSteps:2,input:contract,outcomes:{done:contract},nodes:{a:{component:'a',...(retry?{retry}:{})},b:{component:'b'}},routes:[{from:'a',outcome:'ok',to:{node:'b'}},{from:'b',outcome:'ok',to:{end:'done'}}]}, {resolve:id=>({component:{id,kind:effect?'effect':'transform',implementation:id,inputContract:'value',outcomes:{ok:'value'}},executor})});
 return {compiled,runtime:new WorkflowRuntime(clock)};
}
