import { defineTool } from './sdk.mjs';

/** Only native successful tool-result metadata has selection authority. No outcome file is exposed. */
export default class OutcomeService {
  static inject = ['tools'];
  constructor(ctx, config) {
    const outcomes = config?.outcomes;
    if (!config || Object.keys(config).join(',') !== 'outcomes' || !Array.isArray(outcomes) || outcomes.length < 2 || outcomes.length > 32
      || !outcomes.every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
      || new Set(outcomes).size !== outcomes.length) throw new Error('INVALID_HARNESS_OUTCOMES');
    const allowed = new Set(outcomes), selected = new WeakSet();
    ctx.tools.register(defineTool({
      name: 'agentflow_outcome',
      description: 'After completing all task output files, choose exactly one declared outcome. Once accepted, end your response without calling any further tools. Output contracts are checked separately by the host.',
      parameters: { outcome: { type: 'string', required: true, enum: [...allowed], description: 'The declared outcome for this completed task.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, enum: [...allowed] } } },
        render: (_args, value) => [{ type: 'text', text: `Outcome ${value.outcome} accepted. End your response now; do not call further tools.` }],
        presentationMeta: (_args, value) => ({ schema: 'agentflow-outcome/v1', outcome: value.outcome }),
      },
      execute(args, exec) {
        const session = exec.agent?.session;
        if (!session || exec.parent || exec.signal.aborted) throw new Error('INVALID_OUTCOME_EXECUTION');
        if (!args || Object.keys(args).join(',') !== 'outcome' || !allowed.has(args.outcome)) throw new Error('INVALID_STRUCTURED_OUTCOME');
        if (selected.has(session)) throw new Error('OUTCOME_ALREADY_SELECTED');
        selected.add(session);
        return { outcome: args.outcome };
      },
    }));
  }
}
