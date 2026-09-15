import { spawn } from 'node:child_process';
import { credentialEnvironment } from '../execution/state-binding.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import type { CapturedFile } from '@agentflow/engine';

/** Bounded control output. No shell and no ambient command interpolation. */
export async function docker(args: readonly string[], timeoutMs = 15_000, secrets: Readonly<Record<string, string>> = {}): Promise<string> {
  const selected = credentialEnvironment(secrets);
  if (Object.keys(selected).length && args[0] !== 'create') throw new Error('INVALID_CREDENTIAL_COMMAND');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...selected } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { failed = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('DOCKER_COMMAND_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('DOCKER_COMMAND_FAILED'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

export interface AttachedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  settled: boolean;
  failed: boolean;
  exitCode: number | null;
  stdout: CapturedFile;
  stderr: CapturedFile;
}

/** Private host interaction; never serialized into task configuration or ordinary events. */
export interface DockerInteraction {
  open(input: { write(bytes: Uint8Array): void; end(): void }): () => void;
  output(channel: 'stdout' | 'stderr', bytes: Uint8Array): void;
}

export interface DockerLogObserver { output(channel: 'stdout' | 'stderr', bytes: Uint8Array): void; close(): void }

export function attach(name: string, stdoutPath: string, stderrPath: string, maxBytes: number, interaction?: DockerInteraction, observer?: DockerLogObserver): AttachedProcess {
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
  let stderrFd: number;
  try { stderrFd = openSync(stderrPath, 'wx', 0o600); }
  catch (error) { closeSync(stdoutFd); throw error; }
  const child = spawn('docker', ['start', '--attach', ...(interaction ? ['--interactive'] : []), name], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (!interaction) child.stdin.end();
  const stdout = { path: stdoutPath, bytes: 0, truncated: false, complete: false, error: undefined as string | undefined };
  const stderr = { path: stderrPath, bytes: 0, truncated: false, complete: false, error: undefined as string | undefined };
  const capture = (fd: number, result: typeof stdout, chunk: Buffer) => {
    const remaining = Math.max(0, maxBytes - result.bytes);
    if (chunk.length > remaining) result.truncated = true;
    if (remaining && !result.error) {
      try {
        const kept = chunk.subarray(0, remaining);
        let written = 0;
        while (written < kept.length) {
          const count = writeSync(fd, kept, written, kept.length - written);
          if (!count) throw new Error('CAPTURE_WRITE_FAILED');
          written += count;
          result.bytes += count;
        }
      } catch { result.error = 'CAPTURE_WRITE_FAILED'; }
    }
  };
  const view = (result: typeof stdout): CapturedFile => ({ path: result.path, bytes: result.bytes,
    truncated: result.truncated, complete: result.complete && !process.failed,
    ...(result.error || process.failed ? { error: result.error ?? 'ATTACH_TRANSPORT_FAILED' } : {}) });
  let finish!: () => void;
  const process: AttachedProcess = { child, done: new Promise(resolve => { finish = resolve; }), settled: false, failed: false, exitCode: null,
    get stdout() { return view(stdout); }, get stderr() { return view(stderr); } };
  let dispose: (() => void) | undefined;
  let ended = false, inputBytes = 0;
  const forward = (channel: 'stdout' | 'stderr', fd: number, result: typeof stdout, chunk: Buffer) => {
    capture(fd, result, chunk);
    if (observer) { try { observer.output(channel, new Uint8Array(chunk)); } catch { process.failed = true; } }
    if (interaction && (result.truncated || result.error)) process.failed = true;
    if (interaction && !process.failed) {
      try { interaction.output(channel, new Uint8Array(chunk)); } catch { process.failed = true; }
    }
  };
  child.stdout.on('data', (chunk: Buffer) => forward('stdout', stdoutFd, stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => forward('stderr', stderrFd, stderr, chunk));
  child.stdin.on('error', () => { process.failed = true; });
  if (interaction) {
    try {
      dispose = interaction.open({
        write(bytes) {
          if (ended || process.settled || process.failed || !(bytes instanceof Uint8Array) || bytes.length > 8192 || (inputBytes += bytes.length) > 65536) {
            process.failed = true; throw new Error('INTERACTION_INPUT_REJECTED');
          }
          child.stdin.write(bytes);
        },
        end() { if (!ended) { ended = true; child.stdin.end(); } },
      });
      if (typeof dispose !== 'function') throw new Error('INVALID_INTERACTION_DISPOSER');
    } catch { process.failed = true; child.stdin.end(); }
  }
  child.on('error', () => { process.failed = true; });
  child.on('close', code => {
    process.failed ||= code === null;
    process.exitCode = code;
    process.settled = true;
    try { dispose?.(); observer?.close(); } catch { process.failed = true; }
    stdout.complete = !process.failed && !stdout.error && !stdout.truncated;
    stderr.complete = !process.failed && !stderr.error && !stderr.truncated;
    try { closeSync(stdoutFd); } catch { stdout.error = 'CAPTURE_CLOSE_FAILED'; stdout.complete = false; }
    try { closeSync(stderrFd); } catch { stderr.error = 'CAPTURE_CLOSE_FAILED'; stderr.complete = false; }
    finish();
  });
  return process;
}
