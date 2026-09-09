import { relative, resolve } from 'node:path';
import { LocalSubprocessRuntime } from './process-sdk.mjs';
import { toolIsolateArguments } from './tool-isolate.mjs';
import { toolPolicy } from './process-policy.mjs';

const cleanEnvironment = () => ({ ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), PATH: '/usr/local/bin:/usr/bin:/bin' });

export default class IsolatedSubprocess extends LocalSubprocessRuntime {
  static inject = ['agentflowToolSpace'];
  constructor(ctx) {
    super(ctx);
    this.space = ctx.agentflowToolSpace;
    this.internals.spillDir = this.space.spillDirectory;
    this.space.register(() => this.disposeManagedProcesses());
  }
  resolveExecutable(command, _env, signal) { return super.resolveExecutable(command, cleanEnvironment(), signal); }
  spawnTerminal() { throw new Error('TOOL_TERMINAL_UNSUPPORTED'); }
  spawn(spec) {
    if (this.space.closed) throw new Error('TOOL_SPACE_CLOSED');
    const argv = toolIsolateArguments(this.space.directory, toolPolicy(spec), spec.argv, resolve('/task/work', spec.cwd ?? '/task/work'));
    const handle = super.spawn({ ...spec, argv, cwd: '/task/work', env: cleanEnvironment() });
    // Preserve native byte offsets and bounded full output, but make its path usable in the tool view.
    for (const reader of Object.values(handle.collected)) {
      if (!reader) continue;
      const read = reader.readFrom.bind(reader);
      reader.readFrom = offset => {
        const output = read(offset);
        if (!output.spillPath) return output;
        const path = relative(this.space.directory, output.spillPath);
        if (path.startsWith('../') || path === '..' || path.startsWith('/')) throw new Error('INVALID_TOOL_SPILL_PATH');
        return { ...output, spillPath: `/tmp/${path}` };
      };
    }
    const done = handle.done.then(async outcome => { await handle.waitForExit(); return outcome; }, async error => { await handle.waitForExit(); throw error; });
    return new Proxy(handle, { get(target, key) {
      if (key === 'done') return done;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
