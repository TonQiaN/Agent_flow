import type {ExecutionIdentity} from '@agentflow/domain';
import type {ParallelRecordPort} from '../persistence/types.js';
import type {ParallelExpansion,ParallelCheckpoint} from './types.js';
import {canonicalJson,copyJson} from '../json.js';
export const parallelEqual=(a:unknown,b:unknown)=>canonicalJson(copyJson(a))===canonicalJson(copyJson(b));
export function parallelMetadata(expansion:ParallelExpansion,identity:ExecutionIdentity,port:ParallelRecordPort):ParallelCheckpoint{
 return {kind:expansion.kind,maxConcurrency:expansion.maxConcurrency,children:expansion.children.map((c,index)=>({id:c.id,index:c.index,component:c.component,workflowId:c.compiled.definition.id,runId:port.childRunId(identity,index)}))};
}
