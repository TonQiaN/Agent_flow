import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow, WorkflowRuntime } from '@agentflow/engine';

// A deterministic repair example, not a real grading run or a model substitute.
const maxRepairs = Number(process.argv[2] ?? '2');
if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) throw new Error('Expected a repair limit from 0 to 10');
const contracts = new ContractRegistry();
contracts.register('draft', { type: 'object', properties: { revision: { type: 'integer', minimum: 0 } }, required: ['revision'], additionalProperties: false });
const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
components.register({ id: 'check', kind: 'gate', inputContract: 'draft', outcomes: { accepted: 'draft', revise: 'draft' }, implementation: 'check' });
components.register({ id: 'fix', kind: 'transform', inputContract: 'draft', outcomes: { updated: 'draft' }, implementation: 'fix' });
functions.register('check', draft => ({ outcome: draft.revision >= 2 ? 'accepted' : 'revise', output: draft }));
functions.register('fix', draft => ({ outcome: 'updated', output: { revision: draft.revision + 1 } }));
const draft = { kind: 'json', id: 'draft' };
const plan = compileWorkflow({ id: 'repair-example', start: 'review', input: draft, outcomes: { accepted: draft, rejected: draft }, maxSteps: 20,
  nodes: { review: { component: 'check' }, repair: { component: 'fix' } },
  routes: [{ from: 'review', outcome: 'accepted', to: { end: 'accepted' } },
    { from: 'review', outcome: 'revise', to: { node: 'repair' }, limit: { max: maxRepairs, exhausted: { end: 'rejected' } } },
    { from: 'repair', outcome: 'updated', to: { node: 'review' } }],
}, new JsonFunctionWorkflowCatalog(contracts, components, functions));
const original = { revision: 0 };
const run = new WorkflowRuntime().start(plan, 'example', original);
const result = await run.completion;
console.log(JSON.stringify({ status: result.status, outcome: result.outcome, reason: result.reason, original,
  steps: result.steps.map(step => ({ node: step.node, nodeTaskId: step.result.identity.nodeTaskId, status: step.result.status,
    ...(step.result.status === 'accepted' ? { outcome: step.result.outcome, output: step.result.output } : {}) })), limits: result.limits }, null, 2));
if (original.revision !== 0 || result.status !== (maxRepairs >= 2 ? 'succeeded' : 'exhausted') || result.steps.length !== Math.min(maxRepairs, 2) * 2 + 1) process.exitCode = 1;
