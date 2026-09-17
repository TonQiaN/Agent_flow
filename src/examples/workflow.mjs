import { createRepairExample } from './studio/repair.mjs';
import { localWorkflowHistory } from '@agentflow/integrations';
import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime } from '@agentflow/engine';

// A deterministic repair example, not a real grading run or a model substitute.
const maxRepairs = Number(process.argv[2] ?? '2');
if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) throw new Error('Expected a repair limit from 0 to 10');
const plan = createRepairExample(maxRepairs);
const original = { revision: 0 };
const history = await localWorkflowHistory('workflow.mjs');
const run = new WorkflowRuntime(undefined, history.observer(plan)).start(plan, process.env.AGENTFLOW_STUDIO_RUN_ID ?? 'example', original);
const result = await run.completion;
console.log(JSON.stringify({ status: result.status, outcome: result.outcome, reason: result.reason, original,
  steps: result.steps.map(step => ({ node: step.node, nodeTaskId: step.result.identity.nodeTaskId, status: step.result.status,
    ...(step.result.status === 'accepted' ? { outcome: step.result.outcome, output: step.result.output } : {}) })), limits: result.limits }, null, 2));
if (original.revision !== 0 || result.status !== (maxRepairs >= 2 ? 'succeeded' : 'exhausted') || result.steps.length !== Math.min(maxRepairs, 2) * 2 + 1) process.exitCode = 1;
