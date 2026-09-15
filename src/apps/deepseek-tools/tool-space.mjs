import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Service } from './sdk.mjs';

/** One task-owned temporary view shared by file and process services. Never store credentials here. */
export default class ToolSpace extends Service {
  constructor(ctx) {
    super(ctx, 'agentflowToolSpace');
    this.directory = mkdtempSync('/tmp/agentflow-tools-');
    this.spillDirectory = `${this.directory}/process-output`;
    mkdirSync(this.spillDirectory, { mode: 0o700 });
    this.closers = new Set();
    this.closed = false;
    this.register = this.register.bind(this);
    this.close = this.close.bind(this);
    ctx.effect(() => () => this.close());
  }
  register(close) {
    if (this.closed) throw new Error('TOOL_SPACE_CLOSED');
    this.closers.add(close);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.closers].map(close => close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'TOOL_SPACE_CLEANUP_FAILED');
      await rm(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
