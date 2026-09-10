import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractRegistry} from '../contracts/registry.js';
import {ParallelWorkflowCatalog} from './catalog.js';
import type {ParallelDefinition} from './types.js';
import type {WorkflowCatalog,WorkflowNodeExecutor} from '../workflow/types.js';
const definition:ParallelDefinition={kind:'map',inputContract:'items',outputContract:'joined',component:'extract',itemId:'id',outcome:'joined',maxConcurrency:2,failurePolicy:'wait-all'};
function fixture(kind='transform',files=false,nested=false){
 const contracts=new ContractRegistry();contracts.register('items',{type:'array'});contracts.register('item',{type:'object'});contracts.register('joined',{type:'object'});
 const executor:WorkflowNodeExecutor={validate(){},contract:id=>({kind:files?'files':'json',id}),contractDefinition:id=>({kind:'json',id,schema:contracts.definition(id)}),check:()=>[],executionDefinition:async()=>({schema:'test/v1'}),execute:async()=>{throw new Error('NO_EXECUTION');},...(nested?{parallel:()=>{throw new Error('NO_NESTING');}}:{})};
 const source:WorkflowCatalog={resolve:id=>({component:{id,kind:kind as 'transform',implementation:'test',inputContract:'item',outcomes:{ok:'item'}},executor})};
 return new ParallelWorkflowCatalog(contracts,source);
}
test('parallel definitions reject files, Effects, nesting and unsupported policies before executing anything',()=>{
 for(const args of [['effect',false,false],['transform',true,false],['transform',false,true]] as const){const catalog=fixture(args[0],args[1],args[2]);assert.throws(()=>catalog.register('node',definition),/INVALID_PARALLEL_DEFINITION/);assert.equal(catalog.childWorkflows().length,0);}
 for(const change of [{failurePolicy:'fail-fast'},{maxConcurrency:0},{maxConcurrency:63},{maxConcurrency:1.5},{itemId:''},{extra:true},{kind:'nested'}]){const catalog=fixture();assert.throws(()=>catalog.register('node',{...definition,...change} as ParallelDefinition));assert.equal(catalog.childWorkflows().length,0);}
});
test('Fork rejects invalid branch IDs and nonmatching input contracts before registering child workflows',()=>{
 const fork={kind:'fork',inputContract:'item',outputContract:'joined',outcome:'joined',maxConcurrency:2,failurePolicy:'wait-all',branches:{alpha:{component:'extract'},zeta:{component:'extract'}}} as const;
 for(const change of [{inputContract:'items'},{branches:{only:{component:'extract'}}},{branches:{'bad id':{component:'extract'},zeta:{component:'extract'}}},{branches:{alpha:{component:'extract',flow:'unsupported'},zeta:{component:'extract'}}}]){const catalog=fixture();assert.throws(()=>catalog.register('node',{...fork,...change} as ParallelDefinition));assert.equal(catalog.childWorkflows().length,0);}
});

for (const kind of ['map','fork'] as const) test(`${kind} rejects explicitly supplied invalid retry policies instead of dropping them`,()=>{
 for(const retry of [null,false,0,'']){
  const catalog=fixture();
  const configured=kind==='map'?{...definition,retry}:{kind:'fork',inputContract:'item',outputContract:'joined',outcome:'joined',maxConcurrency:2,failurePolicy:'wait-all',branches:{alpha:{component:'extract'},zeta:{component:'extract',retry}}};
  assert.throws(()=>catalog.register('node',configured as unknown as ParallelDefinition));
  assert.equal(catalog.childWorkflows().length,0);
  // A failed registration must not reserve the structural name or earlier valid branches.
  catalog.register('node',definition);assert.equal(catalog.childWorkflows().length,1);
 }
 const catalog=fixture(),retry={maxAttempts:2,on:['execution_failure'] as const,delayMs:500};
 const configured=kind==='map'?{...definition,retry}:{kind:'fork',inputContract:'item',outputContract:'joined',outcome:'joined',maxConcurrency:2,failurePolicy:'wait-all',branches:{alpha:{component:'extract'},zeta:{component:'extract',retry}}};
 catalog.register('node',configured as ParallelDefinition);
 assert.deepEqual(catalog.childWorkflows().map(c=>c.definition.nodes['unit']!.retry),kind==='map'?[retry]:[undefined,retry]);
});
