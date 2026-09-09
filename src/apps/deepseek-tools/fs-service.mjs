import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolIsolateArguments } from './tool-isolate.mjs';
import { FileSystem, FsError } from './sdk.mjs';

const limit = 32 * 1024 * 1024;

/** The native FileSystem seam; content and metadata operations run in a confined worker. */
export default class IsolatedFileSystem extends FileSystem {
  #tail = Promise.resolve();
  #temporary;
  #stop;
  #closed = false;
  constructor(ctx) {
    super(ctx);
    // Cordis shadows a service with caller-context proxies. This service carries explicit policies and owns one private worker queue.
    for (const method of ['resolve', 'stat', 'lstat', 'readText', 'streamText', 'readBytes', 'listDir', 'writeText', 'editText', 'closeWorker']) {
      this[method] = this[method].bind(this);
    }
    ctx.effect(() => () => this.closeWorker());
  }
  get sandboxMode() { return 'workspace-write'; }
  processPath(target) { return target.targetKey; }
  fileUrl(target) { return pathToFileURL(target.targetKey).href; }
  contains(parent, child) {
    const path = relative(parent.targetKey, child.targetKey);
    return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  }
  resolve(path, opts) { return this.#call('resolve', [path, { cwd: opts?.cwd ?? '/task/work' }], opts?.signal); }
  stat(target, signal) { return this.#call('stat', [target], signal); }
  lstat(path, opts, signal) { return this.#call('lstat', [path, opts ?? {}], signal); }
  readText(target, signal) { return this.#call('readText', [target], signal); }
  async streamText(target, signal) {
    const text = await this.readText(target, signal);
    return (async function* () { yield text; })();
  }
  async readBytes(target, signal, maxBytes) {
    const encoded = await this.#call('readBytes', [target, maxBytes], signal);
    if (typeof encoded !== 'string') throw new FsError('File worker returned invalid bytes', 'FS_IO_ERROR');
    return new Uint8Array(Buffer.from(encoded, 'base64'));
  }
  listDir(target, signal) { return this.#call('listDir', [target], signal); }
  writeText(target, content, expected, signal, policy) { return this.#call('writeText', [target, content, expected ?? null], signal, policy); }
  editText(target, edit, expected, signal, policy) { return this.#call('editText', [target, edit, expected ?? null], signal, policy); }
  async closeWorker() {
    this.#closed = true;
    this.#stop?.('FS_ABORTED');
    await this.#tail;
    if (this.#temporary) await rm(await this.#temporary, { recursive: true, force: true });
  }
  #call(method, args, signal, policy) {
    // No unrestricted escalation or fallback to parent I/O, even when a caller supplies a wider policy.
    const mode = policy?.mode ?? 'workspace-write';
    if (mode !== 'workspace-write' && mode !== 'read-only') return Promise.reject(new FsError('File policy escalation is unsupported', 'FS_PERMISSION_DENIED'));
    if (mode === 'read-only' && ['writeText', 'editText'].includes(method)) return Promise.reject(new FsError('Read-only file policy refuses mutations', 'FS_PERMISSION_DENIED'));
    const op = this.#tail.then(async () => {
      if (this.#closed || signal?.aborted) throw new FsError('File operation aborted', 'FS_ABORTED');
      const body = JSON.stringify({ method, args });
      if (Buffer.byteLength(body) > limit) throw new FsError('File operation exceeds transfer limit', 'FS_TOO_LARGE');
      // Reuse one private tmp directory for this service, so successive operations see the same temporary files.
      const temporary = await (this.#temporary ??= mkdtemp('/tmp/agentflow-tools-'));
      if (this.#closed || signal?.aborted) throw new FsError('File operation aborted', 'FS_ABORTED');
      const argv = toolIsolateArguments(temporary, mode, ['node', '/task/config/deepseek-policy/fs-worker.mjs']);
      return await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
        let output = '', bytes = 0, failure;
        const stop = code => { failure ??= code; child.kill('SIGKILL'); };
        this.#stop = stop;
        const abort = () => stop('FS_ABORTED');
        const timer = setTimeout(() => stop('FS_IO_ERROR'), 30000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || this.#closed) abort();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', part => {
          bytes += Buffer.byteLength(part);
          if (bytes > limit) stop('FS_TOO_LARGE'); else output += part;
        });
        child.stderr.resume();
        child.on('error', () => { failure ??= 'FS_IO_ERROR'; });
        child.stdin.on('error', () => { failure ??= 'FS_IO_ERROR'; });
        child.on('close', code => {
          this.#stop = undefined;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (failure || code !== 0) { reject(new FsError('Isolated file operation failed', failure ?? 'FS_IO_ERROR')); return; }
          try {
            const response = JSON.parse(output);
            if (response.ok === true) resolve(response.value);
            else reject(new FsError('Isolated file operation refused', typeof response.code === 'string' && /^FS_[A-Z_]+$/.test(response.code) ? response.code : 'FS_IO_ERROR'));
          } catch { reject(new FsError('Invalid file worker response', 'FS_IO_ERROR')); }
        });
        child.stdin.end(body);
      });
    });
    this.#tail = op.catch(() => undefined);
    return op;
  }
}
