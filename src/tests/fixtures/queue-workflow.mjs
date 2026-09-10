import { compileWorkflow, WorkflowRuntime } from '@agentflow/engine';
export const credential = id => ({ credentialRef: id, service: 'fixture', method: 'api-key' });
export const configuration = { roles: { producer: 2, fixer: 1 }, credentials: [{ identity: credential('shared'), capacity: 1 }, { identity: credential('other'), capacity: 1 }], workflows: Object.fromEntries(['shared', 'other'].map(id => [id, { a: { role: 'producer', capability: 'json', credential: credential(id) }, b: { role: 'fixer', capability: 'json', credential: credential(id) } }])) };
export function application(workflowId, onInvoke = async () => { }) {
    const contract = { kind: 'json', id: 'number' };
    const executor = { validate() { }, contract: () => contract, contractDefinition: () => ({ ...contract, schema: { type: 'integer' } }), check: (_id, value) => Number.isSafeInteger(value) ? [] : [{ contractId: 'number', path: '$', rule: 'integer', code: 'INVALID_INTEGER' }], executionDefinition: async () => ({ schema: 'fixture-queued-calculation/v1' }), checkRecovery: async () => { },
        execute: async (component, input, identity, cancel) => { await onInvoke({ component: component.id, identity, cancel }); return { status: 'accepted', componentId: component.id, identity, outcome: 'ok', output: input + 1 }; } };
    const compiled = compileWorkflow({ id: workflowId, start: 'a', maxSteps: 2, input: contract, outcomes: { done: contract }, nodes: { a: { component: 'a' }, b: { component: 'b' } }, routes: [{ from: 'a', outcome: 'ok', to: { node: 'b' } }, { from: 'b', outcome: 'ok', to: { end: 'done' } }] }, { resolve: id => ({ component: { id, kind: 'transform', implementation: id, inputContract: 'number', outcomes: { ok: 'number' } }, executor }) });
    return { compiled, runtime: new WorkflowRuntime() };
}
