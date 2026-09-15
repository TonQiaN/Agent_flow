import { LocalBashExecutor } from './process-sdk.mjs';
import { withToolPolicy } from './process-policy.mjs';

/** Native shell lifecycle, with file authority carried only to the mandatory isolated process service. */
export default class IsolatedBash extends LocalBashExecutor {
  static inject = ['subprocess', 'sandboxPolicy'];
  get sandboxMode() { return 'workspace-write'; }
  resolve(request) {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() };
  }
  spawnSpec(spec, argv, stdoutMaxBytes, signal) {
    return withToolPolicy(super.spawnSpec(spec, argv, stdoutMaxBytes, signal), spec.sandboxPolicy?.mode ?? 'workspace-write');
  }
}
