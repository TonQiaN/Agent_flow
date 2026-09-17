import { ContractRegistry, ComponentRegistry, FunctionRegistry, JsonFunctionWorkflowCatalog, compileWorkflow } from '@agentflow/engine';
export function createRepairExample(maxRepairs = 2) {
const contracts = new ContractRegistry();
contracts.register('draft', { type: 'object', properties: { revision: { type: 'integer', minimum: 0 } }, required: ['revision'], additionalProperties: false });
const components = new ComponentRegistry(contracts), functions = new FunctionRegistry();
components.register({ id: 'check', kind: 'gate', inputContract: 'draft', outcomes: { accepted: 'draft', revise: 'draft' }, implementation: 'check' });
components.register({ id: 'fix', kind: 'transform', inputContract: 'draft', outcomes: { updated: 'draft' }, implementation: 'fix' });
functions.register('check', draft => ({ outcome: draft.revision >= 2 ? 'accepted' : 'revise', output: draft }));
functions.register('fix', draft => ({ outcome: 'updated', output: { revision: draft.revision + 1 } }));
const draft = { kind: 'json', id: 'draft' };
return compileWorkflow({ id: 'repair-example', start: 'review', input: draft, outcomes: { accepted: draft, rejected: draft }, maxSteps: 20,
  nodes: { review: { component: 'check' }, repair: { component: 'fix' } },
  routes: [{ from: 'review', outcome: 'accepted', to: { end: 'accepted' } },
    { from: 'review', outcome: 'revise', to: { node: 'repair' }, limit: { max: maxRepairs, exhausted: { end: 'rejected' } } },
    { from: 'repair', outcome: 'updated', to: { node: 'review' } }],
}, new JsonFunctionWorkflowCatalog(contracts, components, functions));
}
