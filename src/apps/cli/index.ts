#!/usr/bin/env node
import { ContractRegistry, ComponentRegistry, ComponentExecutor, FunctionRegistry } from '@agentflow/engine';
import type { JsonObject } from '@agentflow/domain';

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== 'demo') {
    process.stderr.write('Usage: agentflow demo\nRuns a deterministic JSON contract example; no agent or workflow execution yet.\n');
    process.exitCode = 2;
    return;
  }
  const contracts = new ContractRegistry();
  contracts.register('numbers', { type: 'array', items: { type: 'number' }, minItems: 1 });
  contracts.register('total', { type: 'object', properties: { total: { type: 'number' } }, required: ['total'], additionalProperties: false });
  const components = new ComponentRegistry(contracts);
  components.register({ id: 'sum', kind: 'transform', inputContract: 'numbers', outcomes: { completed: 'total' }, implementation: 'sum-v1' });
  const functions = new FunctionRegistry();
  functions.register('sum-v1', input => ({ outcome: 'completed', output: { total: (input as number[]).reduce((a, b) => a + b, 0) } satisfies JsonObject }));
  const executor = new ComponentExecutor(contracts, components, functions);
  const result = await executor.execute('sum', [1, 2, 3], { runId: 'demo-run', nodeTaskId: 'demo-task', attemptId: 'demo-attempt', attemptNumber: 1 });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'accepted') process.exitCode = 1;
}

main().catch(() => { process.stderr.write('DEMO_FAILED\n'); process.exitCode = 1; });
