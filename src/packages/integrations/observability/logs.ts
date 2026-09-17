import { StringDecoder } from 'node:string_decoder';
import type { ExecutionIdentity, JsonValue } from '@agentflow/domain';
import type { DockerLogObserver } from '../docker/process.js';
import { redactView } from './views.js';
export interface ExecutionEvent { readonly identity: ExecutionIdentity; readonly kind: string; readonly data: JsonValue; readonly receivedAt: number }
export type ExecutionEventSink = (event: ExecutionEvent) => Promise<void>;
/** Line boundaries prevent a credential split over transport chunks from escaping redaction. */
export class ExecutionLogCapture implements DockerLogObserver {
  readonly #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  readonly #buffers = { stdout: '', stderr: '' };
  #tail = Promise.resolve(); #bytes = 0; #limited = false; #failed = false;
  constructor(private readonly identity: ExecutionIdentity, private readonly sink: ExecutionEventSink, private readonly redact: (text: string) => string, private readonly limit = 16 * 1024 * 1024) {}
  emit(kind: string, data: unknown): void {
    const receivedAt = Date.now(), safe = redactView(data);
    this.#tail = this.#tail.then(() => this.sink({ identity: this.identity, kind, data: safe, receivedAt })).catch(() => { this.#failed = true; });
  }
  #line(channel: 'stdout' | 'stderr', text: string): void {
    if (this.#limited) return;
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes > this.limit || Buffer.byteLength(text) > 1024 * 1024) { this.#limited = true; this.emit('capture_warning', { reason: 'LOG_LIMIT_EXCEEDED' }); return; }
    const safe = this.redact(text);
    let data: JsonValue = safe;
    if (channel === 'stdout') { try { data = JSON.parse(safe) as JsonValue; } catch { /* Non-JSON lines remain visible text. */ } }
    this.emit(channel, data);
  }
  output(channel: 'stdout' | 'stderr', bytes: Uint8Array): void {
    if (this.#limited) return;
    this.#buffers[channel] += this.#decoders[channel].write(Buffer.from(bytes));
    let end: number;
    while ((end = this.#buffers[channel].indexOf('\n')) !== -1) {
      this.#line(channel, this.#buffers[channel].slice(0, end)); this.#buffers[channel] = this.#buffers[channel].slice(end + 1);
    }
    if (this.#buffers[channel].length > 1024 * 1024) { this.#limited = true; this.#buffers[channel] = ''; this.emit('capture_warning', { reason: 'LOG_LINE_LIMIT_EXCEEDED' }); }
  }
  close(): void {
    for (const channel of ['stdout', 'stderr'] as const) {
      this.#buffers[channel] += this.#decoders[channel].end();
      if (this.#buffers[channel]) this.#line(channel, this.#buffers[channel]);
      this.#buffers[channel] = '';
    }
  }
  async finish(): Promise<{ complete: boolean; truncated: boolean; failed: boolean }> {
    await this.#tail;
    return { complete: !this.#limited && !this.#failed, truncated: this.#limited, failed: this.#failed };
  }
}
