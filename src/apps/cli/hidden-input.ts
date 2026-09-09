import type { ReadStream, WriteStream } from 'node:tty';

let active = false;
/** Terminal UI only; callers own storage and format semantics. No fallback to redirected input. */
export async function readHiddenInput(input: ReadStream = process.stdin, output: WriteStream = process.stderr, timeoutMs = 300000): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('AUTH_INPUT_INVALID_TIMEOUT');
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('AUTH_INPUT_REQUIRES_TERMINAL');
  if (active || input.listenerCount('data') > 0) throw new Error('AUTH_INPUT_BUSY');
  active = true;
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
  const buffer = Buffer.alloc(8192); let length = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code?: string) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      input.off('data', receive); input.off('end', ended); input.off('error', failed); output.off('error', failed);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, cancelled);
      try { input.setRawMode(wasRaw); if (!wasFlowing) input.pause(); }
      catch { code = 'AUTH_TERMINAL_RESTORE_FAILED'; }
      active = false;
      const value = code ? '' : buffer.subarray(0, length).toString('ascii'); buffer.fill(0);
      if (code) reject(new Error(code)); else resolve(value);
    };
    const cancelled = () => finish('AUTH_INPUT_CANCELLED');
    const failed = () => finish('AUTH_INPUT_FAILED');
    const ended = () => finish('AUTH_INPUT_CANCELLED');
    const receive = (raw: Buffer | string) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index]!;
        if (byte === 3 || byte === 4 || byte === 26) return cancelled();
        if (byte === 13 || byte === 10) {
          const rest = bytes.subarray(index + 1);
          if (rest.length && !(byte === 13 && rest.length === 1 && rest[0] === 10)) return finish('AUTH_INPUT_INVALID');
          return finish();
        }
        if (byte === 127 || byte === 8) { if (length) buffer[--length] = 0; continue; }
        if (byte === 21) { buffer.fill(0); length = 0; continue; }
        if (byte < 0x21 || byte > 0x7e || length === buffer.length) return finish('AUTH_INPUT_INVALID');
        buffer[length++] = byte;
      }
    };
    const timer = setTimeout(() => finish('AUTH_INPUT_TIMEOUT'), timeoutMs);
    input.on('end', ended); input.on('error', failed); output.on('error', failed);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, cancelled);
    try {
      // Disable echo before announcing readiness, including to automated terminal callers.
      input.setRawMode(true); input.on('data', receive); input.resume();
      output.write('DeepSeek API key (hidden): ', error => { if (error) failed(); });
    } catch { failed(); }
  });
}
