import {parallelEqual} from './metadata.js';
import type {ExecutionIdentity,JsonValue} from '@agentflow/domain';
import {DefinitionError} from '../errors.js';
import {copyJson} from '../json.js';
import type {RunRecordStore,ParallelRecordPort} from '../persistence/types.js';
import {CheckpointWriter} from '../workflow/checkpoint.js';
import {loadWorkflowCheckpoint} from '../workflow/load-checkpoint.js';
import type {WorkflowIssue,WorkflowSnapshot} from '../workflow/types.js';
import type {ParallelExpansion,ParallelCheckpoint} from './types.js';
export async function parallelSeeds(expansion:ParallelExpansion,metadata:ParallelCheckpoint):Promise<readonly {runId:string;content:JsonValue}[]>{
 return Promise.all(expansion.children.map(async(child,index)=>{
  const runId=metadata.children[index]!.runId;let content:JsonValue|undefined;
  const records:RunRecordStore={read:async()=>null,create:async(id,value)=>{if(content!==undefined)throw new DefinitionError('PARALLEL_SEED_DUPLICATE');content=value;return{runId:id,revision:1,content:value};},compareAndSwap:async()=>{throw new DefinitionError('PARALLEL_SEED_MUTATION');}};
  const writer=await CheckpointWriter.prepare(child.compiled,runId,records),d=child.compiled.definition;
  writer.acceptValue(await writer.saveValue(d.start,d.input,child.input));
  const view:WorkflowSnapshot={runId,workflowId:d.id,status:'queued',currentNode:d.start,currentIdentity:null,cancelRequested:false,outcome:null,reason:null,issues:[],steps:[],limits:[],lastAccepted:null};
  await writer.write(view,{node:d.start,value:child.input,traversals:{}});return{runId,content:content!};
 }));
}
export async function collectParallel(expansion:ParallelExpansion,metadata:ParallelCheckpoint,store:RunRecordStore):Promise<{pending:boolean;issues:WorkflowIssue[];output:JsonValue}>{
 const entries:JsonValue[]=[],issues:WorkflowIssue[]=[];let pending=false;
 for(const [index,child] of expansion.children.entries()){
  const record=await loadWorkflowCheckpoint(child.compiled,metadata.children[index]!.runId,store);
  try{
   const c=record.checkpoint,v=c.snapshot;
   if(!parallelEqual(c.values[0]!.value,child.input))throw new DefinitionError('PARALLEL_CHILD_INPUT_MISMATCH');
   if(!['succeeded','failed','cancelled','exhausted'].includes(v.status)){pending=true;continue;}
   const step=v.steps.at(-1);
   if(v.status==='succeeded'&&step?.result.status==='accepted')entries.push(copyJson({id:child.id,...(expansion.kind==='map'?{index:child.index}:{}),component:child.component,outcome:step.result.outcome,output:step.result.output}));
   else if(v.status==='cancelled'||step?.result.status==='failed'&&step.result.stopped)issues.push({contractId:child.compiled.definition.input.id,path:`$[${index}]`,rule:child.id,code:v.reason??'PARALLEL_CHILD_FAILED'});
   else pending=true;
  }finally{await record.dispose();}
 }
 return {pending,issues,output:{[expansion.kind==='map'?'items':'branches']:entries}};
}
