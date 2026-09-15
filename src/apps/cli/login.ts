import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isIdentifier } from '@agentflow/domain';
import { FileCredentialStore, CodexSubscriptionCodec, ClaudeSubscriptionCodec, CodexSubscriptionLoginDriver,
  ClaudeSubscriptionLoginDriver, SubscriptionLoginCoordinator, CredentialError } from '@agentflow/integrations';
import { LoginTerminal } from './login-terminal.js';

const usage = 'Usage: agentflow auth login <codex|claude> --store <absolute-directory> --credential-ref <id> --workspace <absolute-directory> --image <image> --proxy-image <image> [--timeout-ms <1..1800000>]';
/** Native authentication is explicit terminal work. No discovery, supplied token, browser or task configuration. */
export async function login(args: readonly string[]): Promise<number> {
  const [provider, ...tail] = args; const values = new Map<string, string>();
  if (!['codex', 'claude'].includes(provider ?? '') || tail.length % 2) { process.stderr.write(usage + '\n'); return 2; }
  for (let i = 0; i < tail.length; i += 2) {
    const key = tail[i]!, value = tail[i + 1]!;
    if (!['--store', '--credential-ref', '--workspace', '--image', '--proxy-image', '--timeout-ms'].includes(key) || values.has(key) || !value || value.startsWith('--')) {
      process.stderr.write(usage + '\n'); return 2;
    }
    values.set(key, value);
  }
  const storeRoot = values.get('--store'), ref = values.get('--credential-ref'), workspaceRoot = values.get('--workspace');
  const image = values.get('--image'), proxyImage = values.get('--proxy-image'), timeout = values.get('--timeout-ms') ?? '600000', timeoutMs = Number(timeout);
  if (!storeRoot || !isAbsolute(storeRoot) || storeRoot.includes('\0') || !ref || !isIdentifier(ref)
    || !workspaceRoot || !isAbsolute(workspaceRoot) || /[,\0]/.test(workspaceRoot) || !image || !proxyImage
    || [image, proxyImage].some(x => !/^[A-Za-z0-9][A-Za-z0-9./_:@-]*$/.test(x))
    || !/^[1-9][0-9]*$/.test(timeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 1800000) {
    process.stderr.write(usage + '\n'); return 2;
  }
  let terminal: LoginTerminal | undefined;
  try {
    terminal = new LoginTerminal(timeoutMs);
    const store = new FileCredentialStore(storeRoot, [new CodexSubscriptionCodec(), new ClaudeSubscriptionCodec()]);
    const options = { workspaceRoot, image, proxyImage, timeoutMs };
    const driver = provider === 'codex' ? new CodexSubscriptionLoginDriver(options, terminal) : new ClaudeSubscriptionLoginDriver(options, terminal);
    terminal.start();
    const id = randomUUID();
    const attempt = await new SubscriptionLoginCoordinator(store).run({
      identity: { runId: `login-${id}`, nodeTaskId: `login-${id}`, attemptId: `login-${id}`, attemptNumber: 1 },
      credential: { credentialRef: ref, service: provider === 'codex' ? 'openai' : 'anthropic', method: 'subscription' },
    }, driver, terminal);
    if (attempt.result.status === 'pending_cleanup') await attempt.retryCleanup();
    terminal.close();
    const result = attempt.result;
    process.stdout.write(JSON.stringify(result) + '\n');
    if (terminal.diagnostic) process.stderr.write('\n' + terminal.diagnostic + '\n');
    if (result.status === 'pending_cleanup') { process.stderr.write('AUTH_LOGIN_CLEANUP_PENDING\n'); return 3; }
    return result.status === 'configured' ? 0 : 1;
  } catch (error) {
    const code = error instanceof CredentialError ? error.code : error instanceof Error && /^AUTH_LOGIN_[A-Z_]+$/.test(error.message) ? error.message : 'AUTH_LOGIN_FAILED';
    process.stderr.write(code + '\n'); return 1;
  } finally { try { terminal?.close(); } catch { process.stderr.write('AUTH_LOGIN_TERMINAL_RESTORE_FAILED\n'); } }
}
