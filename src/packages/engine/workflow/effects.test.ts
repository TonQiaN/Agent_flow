import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry } from '../components/registry.js';
import { ContractRegistry } from '../contracts/registry.js';
import { EffectExecutor, EFFECT_RECEIPT_SCHEMA } from '../components/effect-executor.js';
import type { EffectAdapter, EffectAdapterRequest, EffectReceipt } from '../components/effect-executor.js';
import type { EffectRecordStore } from '../persistence/effects.js';
import { EffectWorkflowCatalog } from './effects.js';
import { compileWorkflow } from './compiler.js';
import { snapshotWorkflowExecution } from './execution.js';
import { WorkflowRuntime } from './runtime.js';
function fixture() {
 const contracts=new ContractRegistry();contracts.register('json',{});const components=new ComponentRegistry(contracts);
 components.register({id:'publish',kind:'effect',implementation:'publisher',inputContract:'json',outcomes:{applied:'json','already-applied':'json',simulated:'json'}});
 let calls=0,reads=0,grants=0;
 const receipt=(r:EffectAdapterRequest):EffectReceipt=>{const {input:_,...context}=r;return {schema:EFFECT_RECEIPT_SCHEMA,...context,status:r.mode==='apply'?'applied':'simulated',reference:null};};
 const adapter:EffectAdapter={implementation:'publisher',serviceIdentity:'service',definition:async()=>({schema:'installed/v1'}),
  simulate:async r=>{calls++;return receipt(r);},apply:async r=>{calls++;return receipt(r);}};
 const store:EffectRecordStore={identity:'journal',read:async()=>{reads++;return null;},create:async()=>{throw new Error('not expected');},compareAndSwap:async()=>{throw new Error('not expected');}};
 const flow=(catalog:EffectWorkflowCatalog)=>compileWorkflow({id:'flow',start:'node',input:{kind:'json',id:'json'},outcomes:{done:{kind:'json',id:'json'}},maxSteps:1,nodes:{node:{component:'publish'}},routes:['applied','already-applied','simulated'].map(outcome=>({from:'node',outcome,to:{end:'done'}}))},catalog);
 return {contracts,components,adapter,store,flow,grant:()=>{grants++;},counts:()=>({calls,reads,grants})};
}
test('persistent Effect rejects undescribed dynamic mappings, dry-run and missing actual capabilities before writes',async()=>{
 for(const missing of ['mapping','dry-run','adapter','journal','invalid-adapter']) {
  const f=fixture();if(missing==='adapter')delete f.adapter.definition;if(missing==='invalid-adapter')f.adapter.definition=async()=>({});
  const executor=new EffectExecutor(f.contracts,f.components,f.adapter,missing==='journal'?undefined:f.store),catalog=new EffectWorkflowCatalog(f.contracts,f.components,executor);
  catalog.register('publish',{mode:missing==='dry-run'?'dry-run':'apply',operation:missing==='mapping'?()=>({target:'target',key:'key'}):{target:'target',key:'key'}});
  let writes=0;const records={read:async()=>null,create:async()=>{writes++;throw new Error();},compareAndSwap:async()=>{writes++;throw new Error();}};
  await assert.rejects(new WorkflowRuntime().startPersisted(f.flow(catalog),'run',{},records),/EFFECT_EXECUTION_DEFINITION/);assert.equal(writes,0);assert.deepEqual(f.counts(),{calls:0,reads:0,grants:0});
 }
 const f=fixture(),executor=new EffectExecutor(f.contracts,f.components,f.adapter),catalog=new EffectWorkflowCatalog(f.contracts,f.components,executor);
 catalog.register('publish',{operation:()=>({target:'target',key:'key'})});assert.equal((await new WorkflowRuntime().start(f.flow(catalog),'ordinary',{}).completion).status,'succeeded');
});
test('Effect execution description comes from captured installed methods and copied fixed operation without approval or IO',async()=>{
 const f=fixture(),executor=new EffectExecutor(f.contracts,f.components,f.adapter,f.store),catalog=new EffectWorkflowCatalog(f.contracts,f.components,executor),operation={target:'target',key:'key'};
 catalog.register('publish',{mode:'apply',operation,approval:r=>{f.grant();return executor.authorize(r);}});const flow=f.flow(catalog);
 operation.target='changed';f.adapter.definition=async()=>({schema:'replaced'});
 const snapshot=await snapshotWorkflowExecution(flow),binding=snapshot.bindings['node'] as any;
 assert.deepEqual(binding.operation,{target:'target',key:'key'});assert.equal(binding.execution.adapter.schema,'installed/v1');assert.equal(binding.execution.journalIdentity,'journal');
 binding.operation.key='mutated-copy';assert.equal(((await snapshotWorkflowExecution(flow)).bindings['node'] as any).operation.key,'key');assert.deepEqual(f.counts(),{calls:0,reads:0,grants:0});
});
