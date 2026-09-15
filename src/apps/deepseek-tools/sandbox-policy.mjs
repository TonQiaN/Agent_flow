import { Service } from './sdk.mjs';
import { effectiveSandboxMode } from './process-sdk.mjs';

export default class TaskPolicy extends Service {
  constructor(ctx) {
    super(ctx, 'sandboxPolicy');
    this.defaultMode = 'workspace-write';
    this.workspaceRoot = '/task/work';
    ctx.inject(['systemPrompt'], scope => scope.systemPrompt.context({
      name: 'sandbox:policy', order: 110, text: context => {
        const policy = this.resolve({ session: context.agent?.session });
        return policy.mode === 'read-only'
          ? 'Current task file policy: read-only. Task files cannot be modified. Tool processes have private temporary space; tool network access is disabled.'
          : 'Current task file policy: workspace-write. Tools may modify /task/input, /task/work, /task/outputs and shared /tmp. Host originals are separate. /task/state is hidden and /task/config is read-only. Tool network access is disabled.';
      },
    }));
  }
  overrideOf(session) { return effectiveSandboxMode(session.events); }
  resolve({ session, mode } = {}) {
    const effective = mode ?? (session ? this.overrideOf(session) : undefined) ?? this.defaultMode;
    if (!['read-only', 'workspace-write'].includes(effective)) throw new Error('UNSUPPORTED_TOOL_POLICY');
    if (session?.header.cwd !== undefined && session.header.cwd !== '/task/work') throw new Error('UNSUPPORTED_TOOL_WORKSPACE');
    return { mode: effective, workspaceRoot: this.workspaceRoot, ...(session ? { sessionId: session.id } : {}) };
  }
}
