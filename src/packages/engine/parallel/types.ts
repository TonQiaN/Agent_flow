import type { JsonValue } from '@agentflow/domain';
import type { CompiledWorkflow } from '../workflow/types.js';
import type { RetryPolicy } from '../retry/policy.js';
export interface ParallelBranch { readonly component: string; readonly retry?: RetryPolicy }
interface Common { readonly inputContract: string; readonly outputContract: string; readonly outcome: string; readonly maxConcurrency: number; readonly failurePolicy: 'wait-all' }
export type ParallelDefinition = Common & ({ readonly kind:'map'; readonly itemId:string; readonly component:string; readonly retry?:RetryPolicy }
  | { readonly kind:'fork'; readonly branches:Readonly<Record<string,ParallelBranch>> });
export interface ParallelUnit { readonly id:string; readonly index:number|null; readonly component:string; readonly input:JsonValue; readonly compiled:CompiledWorkflow }
export interface ParallelExpansion { readonly kind:'map'|'fork'; readonly maxConcurrency:number; readonly outcome:string; readonly children:readonly ParallelUnit[] }
export interface ParallelCheckpoint {
 readonly kind:'map'|'fork'; readonly maxConcurrency:number;
 readonly children:readonly {readonly id:string;readonly index:number|null;readonly component:string;readonly runId:string;readonly workflowId:string}[];
}
