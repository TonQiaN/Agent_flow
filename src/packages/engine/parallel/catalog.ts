import {isIdentifier} from '@agentflow/domain';
import type {ComponentDefinition,JsonValue} from '@agentflow/domain';
import {DefinitionError} from '../errors.js';
import {copyJson,canonicalJson} from '../json.js';
import {ContractRegistry} from '../contracts/registry.js';
import {compileWorkflow,getPlan,snapshot} from '../workflow/compiler.js';
import {snapshotWorkflowExecution} from '../workflow/execution.js';
import type {CompiledWorkflow,WorkflowCatalog,WorkflowNodeExecutor} from '../workflow/types.js';
import type {ParallelDefinition,ParallelExpansion,ParallelBranch} from './types.js';
const equal=(a:unknown,b:unknown)=>canonicalJson(copyJson(a))===canonicalJson(copyJson(b));
const valid=(v:unknown)=>{if(!v)throw new DefinitionError('INVALID_PARALLEL_DEFINITION');};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Structural catalog only. Child execution always returns to the ordinary engine/queue. */
export class ParallelWorkflowCatalog implements WorkflowCatalog,WorkflowNodeExecutor {
 readonly #definitions=new Map<string,ParallelDefinition>();
 readonly #components=new Map<string,ComponentDefinition>();
 readonly #children=new Map<string,CompiledWorkflow>();
 readonly #units=new Map<string,ReadonlyMap<string,CompiledWorkflow>>();
 constructor(private readonly contracts:ContractRegistry,private readonly catalog:WorkflowCatalog){}
 register(id:string,raw:ParallelDefinition):void{
  const d=snapshot(raw);valid(isIdentifier(id)&&!this.#definitions.has(id)&&object(d));
  valid(['map','fork'].includes(d.kind)&&d.failurePolicy==='wait-all'&&isIdentifier(d.inputContract)&&isIdentifier(d.outputContract)&&isIdentifier(d.outcome)
   &&Number.isSafeInteger(d.maxConcurrency)&&d.maxConcurrency>=1&&d.maxConcurrency<=62);
  const expected=['kind','inputContract','outputContract','outcome','maxConcurrency','failurePolicy',...(d.kind==='map'?['itemId','component',...(Object.hasOwn(d,'retry')?['retry']:[])]:['branches'])];
  valid(Object.keys(d).sort().join(',')===expected.sort().join(','));this.contracts.definition(d.inputContract);this.contracts.definition(d.outputContract);
  const branches:Record<string,ParallelBranch>=d.kind==='map'?{map:{component:d.component,...(d.retry?{retry:d.retry}:{})}}:d.branches;
  valid(object(branches)&&Object.keys(branches).length>=(d.kind==='map'?1:2)&&Object.keys(branches).length<=62);
  if(d.kind==='map')valid(typeof d.itemId==='string'&&d.itemId.length>0&&d.itemId.length<=128);
  const units=new Map<string,CompiledWorkflow>();
  for(const branch of Object.keys(branches).sort()){
   const item=branches[branch]!;valid(isIdentifier(branch)&&object(item)&&Object.keys(item).sort().join(',')===(Object.hasOwn(item,'retry')?'component,retry':'component')&&isIdentifier(item.component));
   const resolved=this.catalog.resolve(item.component),c=resolved.component,e=resolved.executor;
   valid(c.kind!=='effect'&&!e.parallel);
   valid([c.inputContract,...Object.values(c.outcomes)].every(ref=>e.contract(ref).kind==='json'));
   if(d.kind==='fork')valid(c.inputContract===d.inputContract&&e.contractDefinition&&equal(e.contractDefinition(c.inputContract),{kind:'json',id:d.inputContract,schema:this.contracts.definition(d.inputContract)}));
   const workflowId=`${id}-unit-${branch}`;valid(isIdentifier(workflowId)&&!this.#children.has(workflowId));
   const compiled=compileWorkflow({id:workflowId,start:'unit',maxSteps:1,input:{kind:'json',id:c.inputContract},outcomes:Object.fromEntries(Object.entries(c.outcomes).map(([outcome,ref])=>[outcome,{kind:'json',id:ref}])),
    nodes:{unit:{component:c.id,...(item.retry?{retry:item.retry}:{})}},routes:Object.keys(c.outcomes).map(outcome=>({from:'unit',outcome,to:{end:outcome}}))},this.catalog);
   units.set(branch,compiled);
  }
  this.#definitions.set(id,d);this.#units.set(id,units);
  for(const compiled of units.values())this.#children.set(compiled.definition.id,compiled);
  this.#components.set(id,{id,kind:'transform',implementation:'parallel-structure-v1',inputContract:d.inputContract,outcomes:{[d.outcome]:d.outputContract}});
 }
 childWorkflows():readonly CompiledWorkflow[]{return [...this.#children.values()];}
 childWorkflow(id:string):CompiledWorkflow|undefined{return this.#children.get(id);}
 resolve(id:string):{component:ComponentDefinition;executor:WorkflowNodeExecutor}{const component=this.#components.get(id);return component?{component:snapshot(component),executor:this}:this.catalog.resolve(id);}
 validate(component:ComponentDefinition):void{if(!equal(component,this.#components.get(component.id)))throw new DefinitionError('INVALID_PARALLEL_BINDING');}
 contract(id:string){this.contracts.definition(id);return {kind:'json' as const,id};}
 contractDefinition(id:string){return {...this.contract(id),schema:this.contracts.definition(id)};}
 check(id:string,value:JsonValue){const r=this.contracts.check(id,value);return r.valid?[]:r.issues.map(i=>({contractId:id,path:i.instancePath,rule:i.schemaPath,code:i.keyword}));}
 async executionDefinition(component:ComponentDefinition):Promise<JsonValue>{this.validate(component);return copyJson({schema:'agentflow-parallel-node/v1',definition:this.#definitions.get(component.id),children:await Promise.all([...this.#units.get(component.id)!].map(async([id,compiled])=>({id,execution:await snapshotWorkflowExecution(compiled)})))});}
 async checkRecovery():Promise<void>{}
 parallel(component:ComponentDefinition,input:JsonValue):ParallelExpansion{
  this.validate(component);const d=this.#definitions.get(component.id)!,units=this.#units.get(component.id)!,own=snapshot(input);
  if(this.check(d.inputContract,own).length)throw new DefinitionError('INVALID_PARALLEL_INPUT');
  const children=d.kind==='map'?(()=>{
   if(!Array.isArray(own)||own.length>62)throw new DefinitionError('INVALID_MAP_INPUT');
   const ids=new Set<string>(),compiled=units.get('map')!;
   return own.map((value,index)=>{const id=object(value)?value[d.itemId]:undefined;if(typeof id!=='string'||!id.trim()||id.length>128||ids.has(id))throw new DefinitionError('INVALID_MAP_ITEM_ID');ids.add(id);return{id,index,component:d.component,input:snapshot(value),compiled};});
  })():[...units].map(([id,compiled])=>({id,index:null,component:d.branches[id]!.component,input:snapshot(own),compiled}));
  // Validate every item before any durable expansion or child dispatch.
  for(const child of children){const b=getPlan(child.compiled).bindings.get('unit')!;if(b.executor.check(b.component.inputContract,snapshot(child.input)).length)throw new DefinitionError('INVALID_PARALLEL_ITEM_INPUT');}
  return {kind:d.kind,maxConcurrency:d.maxConcurrency,outcome:d.outcome,children};
 }
 async execute():Promise<never>{throw new DefinitionError('PARALLEL_REQUIRES_QUEUE');}
}
