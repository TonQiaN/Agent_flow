import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry, FunctionRegistry } from '../components/registry.js';
import { ComponentExecutor } from '../components/executor.js';
import { ContractRegistry } from '../contracts/registry.js';
import type { JsonValue } from '@agentflow/domain';
import { JsonFunctionWorkflowCatalog } from './functions.js';
import { compileWorkflow } from './compiler.js';
import { WorkflowRuntime } from './runtime.js';
import { snapshotWorkflowExecution } from './execution.js';
const identity={runId:'run',nodeTaskId:'task',attemptId:'attempt',attemptNumber:1};
function fixture(){
 const contracts=new ContractRegistry();contracts.register('json',{});const components=new ComponentRegistry(contracts),functions=new FunctionRegistry();
 components.register({id:'transform',kind:'transform',implementation:'implementation',inputContract:'json',outcomes:{done:'json'}});
 const catalog=new JsonFunctionWorkflowCatalog(contracts,components,functions),value={kind:'json' as const,id:'json'};
 const flow=()=>compileWorkflow({id:'flow',start:'node',input:value,outcomes:{done:value},maxSteps:1,nodes:{node:{component:'transform'}},routes:[{from:'node',outcome:'done',to:{end:'done'}}]},catalog);
 return{contracts,components,functions,catalog,flow};
}
test('deterministic registration captures code, revision and actual config; each call receives private JSON and no Attempt identity',async()=>{
 const f=fixture(),config={nested:{amount:2}},input={count:1};let calls=0;
 const implementation={revision:'package-v1',run:(value:JsonValue,settings:JsonValue)=>{
  calls++;assert.deepEqual(settings,{nested:{amount:2}});const output={count:(value as any).count+(settings as any).nested.amount};(value as any).count=99;(settings as any).nested.amount=99;return{outcome:'done',output};
 }};
 f.functions.registerDeterministic('implementation',implementation,config);
 const definition=f.functions.definition('implementation') as any;definition.config.nested.amount=999;config.nested.amount=100;
 implementation.revision='new-version';implementation.run=()=>{throw new Error('replaced');};
 const executor=new ComponentExecutor(f.contracts,f.components,f.functions);
 for(const n of [1,2]){const result=await executor.execute('transform',input,{...identity,attemptNumber:n});assert.equal(result.status,'accepted');assert.deepEqual((result as any).output,{count:3});}
 assert.deepEqual(input,{count:1});assert.equal(calls,2);
 const snapshot=await snapshotWorkflowExecution(f.flow());assert.deepEqual(snapshot.bindings['node'],{schema:'agentflow-deterministic-function/v1',implementation:'implementation',revision:'package-v1',config:{nested:{amount:2}},recovery:'recompute'});
 await f.catalog.checkRecovery(f.components.get('transform'));assert.equal(calls,2);
});
test('legacy functions still execute but cannot start persistent runs without an explicit deterministic installation',async()=>{
 const f=fixture();let calls=0,writes=0;f.functions.register('implementation',input=>{calls++;return{outcome:'done',output:input};});
 const store={read:async()=>null,create:async()=>{writes++;throw new Error();},compareAndSwap:async()=>{writes++;throw new Error();}};
 await assert.rejects(new WorkflowRuntime().startPersisted(f.flow(),'run',{},store),/FUNCTION_EXECUTION_DEFINITION_UNAVAILABLE/);assert.equal(calls,0);assert.equal(writes,0);
 assert.equal((await new WorkflowRuntime().start(f.flow(),'ordinary',{}).completion).status,'succeeded');assert.equal(calls,1);
 await assert.rejects(f.catalog.checkRecovery(f.components.get('transform')),/FUNCTION_EXECUTION_DEFINITION_UNAVAILABLE/);
});
test('malformed deterministic registrations fail without partially installing a function',()=>{
 for(const revision of ['', ' ', '\n', 4, 'x'.repeat(257)]){const registry=new FunctionRegistry();assert.throws(()=>registry.registerDeterministic('fn',{revision:revision as string,run:()=>({outcome:'ok',output:null})}),/INVALID_DETERMINISTIC_IMPLEMENTATION/);assert.throws(()=>registry.get('fn'),/UNKNOWN_IMPLEMENTATION/);}
 const registry=new FunctionRegistry();assert.throws(()=>registry.registerDeterministic('fn',{revision:'v1',run:()=>({outcome:'ok',output:null})},{bad:undefined} as unknown as JsonValue),/INVALID_DETERMINISTIC_CONFIG/);assert.throws(()=>registry.get('fn'),/UNKNOWN_IMPLEMENTATION/);
 registry.register('fn',()=>({outcome:'ok',output:null}));assert.throws(()=>registry.registerDeterministic('fn',{revision:'v1',run:()=>({outcome:'ok',output:null})}),/DUPLICATE_IMPLEMENTATION/);assert.throws(()=>registry.definition('fn'),/FUNCTION_EXECUTION_DEFINITION_UNAVAILABLE/);
});
