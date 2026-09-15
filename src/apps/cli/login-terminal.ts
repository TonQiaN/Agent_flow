import type { ReadStream, WriteStream } from 'node:tty';
import { StringDecoder } from 'node:string_decoder';
import type { DockerInteraction } from '@agentflow/integrations';

let active = false;
/** Private terminal facade. It owns no credential store, browser, Docker resource or login semantics. */
export class LoginTerminal implements DockerInteraction {
  readonly #input: ReadStream; readonly #output: WriteStream; readonly #timeoutMs: number;
  #transport: Parameters<DockerInteraction['open']>[0] | null = null;
  #started = false; #closed = false; #cancelled = false; #diagnostic: string | null = null;
  #wasRaw = false; #wasFlowing = false; #timer: ReturnType<typeof setTimeout> | undefined;
  #buffer = Buffer.alloc(8191); #length = 0; #submitted = 0;
  #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  constructor(timeoutMs: number, input: ReadStream = process.stdin, output: WriteStream = process.stderr) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) throw new Error('AUTH_LOGIN_INVALID_TIMEOUT');
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('AUTH_LOGIN_REQUIRES_TERMINAL');
    this.#timeoutMs = timeoutMs; this.#input = input; this.#output = output;
  }
  requested = (): boolean => this.#cancelled;
  get diagnostic(): string | null { return this.#diagnostic; }
  #cancel = (code = 'AUTH_LOGIN_CANCELLED'): void => {
    this.#cancelled = true; this.#diagnostic ??= code; this.#buffer.fill(0); this.#length = 0;
    try { this.#transport?.end(); } catch { /* Cancellation remains set; Runner still proves termination. */ }
  };
  #signal = (): void => this.#cancel();
  #failed = (): void => this.#cancel('AUTH_LOGIN_TERMINAL_FAILED');
  #ended = (): void => this.#cancel('AUTH_LOGIN_TERMINAL_CLOSED');
  #receive = (raw: Buffer | string): void => {
    if (this.#cancelled || this.#closed) return;
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]!;
      if (byte === 3 || byte === 4 || byte === 26) return this.#cancel();
      if (!this.#transport) return this.#cancel('AUTH_LOGIN_INPUT_NOT_READY');
      if (byte === 10 || byte === 13) {
        const rest = bytes.subarray(index + 1);
        if (rest.length && !(byte === 13 && rest.length === 1 && rest[0] === 10)) return this.#cancel('AUTH_LOGIN_INPUT_INVALID');
        if (!this.#length || this.#submitted + this.#length + 1 > 65536) return this.#cancel('AUTH_LOGIN_INPUT_INVALID');
        const line = Buffer.alloc(this.#length + 1); this.#buffer.copy(line, 0, 0, this.#length); line[this.#length] = 10;
        this.#submitted += line.length; this.#buffer.fill(0); this.#length = 0;
        try { this.#transport.write(line); } catch { this.#cancel('AUTH_LOGIN_INPUT_FAILED'); }
        // The transport may retain its own copy; it is responsible for its write lifetime.
        return;
      }
      if (byte === 127 || byte === 8) { if (this.#length) this.#buffer[--this.#length] = 0; continue; }
      if (byte === 21) { this.#buffer.fill(0); this.#length = 0; continue; }
      if (byte < 0x21 || byte > 0x7e || this.#length === this.#buffer.length) return this.#cancel('AUTH_LOGIN_INPUT_INVALID');
      this.#buffer[this.#length++] = byte;
    }
  };
  start(): void {
    if (this.#started || this.#closed || active || this.#input.listenerCount('data') > 0) throw new Error('AUTH_LOGIN_TERMINAL_BUSY');
    active = true; this.#started = true;
    this.#wasRaw = this.#input.isRaw; this.#wasFlowing = this.#input.readableFlowing === true;
    this.#input.on('data', this.#receive); this.#input.on('end', this.#ended); this.#input.on('error', this.#failed); this.#output.on('error', this.#failed);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, this.#signal);
    try {
      this.#input.setRawMode(true); this.#input.resume();
      this.#timer = setTimeout(() => this.#cancel('AUTH_LOGIN_TIMEOUT'), this.#timeoutMs);
      this.#output.write('Preparing subscription login. Ctrl-C cancels; authorization input is hidden.\r\n', error => { if (error) this.#failed(); });
    } catch { this.close(); throw new Error('AUTH_LOGIN_TERMINAL_FAILED'); }
  }
  open(input: Parameters<DockerInteraction['open']>[0]): () => void {
    if (!this.#started || this.#closed || this.#cancelled || this.#transport) throw new Error('AUTH_LOGIN_TERMINAL_UNAVAILABLE');
    this.#transport = input;
    return () => { this.#transport = null; this.#buffer.fill(0); this.#length = 0; };
  }
  output(channel: 'stdout' | 'stderr', bytes: Uint8Array): void {
    if (!this.#started || this.#closed || this.#cancelled) throw new Error('AUTH_LOGIN_TERMINAL_UNAVAILABLE');
    // Output is private but can carry terminal escape instructions. Preserve text, not terminal controls.
    const text = this.#decoders[channel].write(Buffer.from(bytes)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    this.#output.write(text.replace(/\n/g, '\r\n'), error => { if (error) this.#failed(); });
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    if (!this.#started) return;
    clearTimeout(this.#timer); this.#transport = null; this.#buffer.fill(0); this.#length = 0;
    this.#input.off('data', this.#receive); this.#input.off('end', this.#ended); this.#input.off('error', this.#failed); this.#output.off('error', this.#failed);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, this.#signal);
    active = false;
    try { this.#input.setRawMode(this.#wasRaw); if (!this.#wasFlowing) this.#input.pause(); }
    catch { throw new Error('AUTH_LOGIN_TERMINAL_RESTORE_FAILED'); }
  }
}
