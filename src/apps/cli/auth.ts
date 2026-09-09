import { isAbsolute } from 'node:path';
import { isIdentifier } from '@agentflow/domain';
import { FileCredentialStore, DeepSeekApiKeyCodec, CredentialError } from '@agentflow/integrations';
import { readHiddenInput } from './hidden-input.js';

const usage = 'Usage: agentflow auth <configure|inspect|delete> deepseek --store <absolute-directory> --credential-ref <id> [--file <absolute-file>]';
/** Explicit local management. No profile discovery, remote checks, model requests or subscription login. */
export async function auth(args: readonly string[]): Promise<number> {
  const [operation, provider, ...tail] = args;
  const options = new Map<string, string>();
  if (!['configure', 'inspect', 'delete'].includes(operation ?? '') || provider !== 'deepseek' || tail.length % 2 !== 0) {
    process.stderr.write(usage + '\n'); return 2;
  }
  for (let index = 0; index < tail.length; index += 2) {
    const name = tail[index]!, value = tail[index + 1]!;
    if (!['--store', '--credential-ref', '--file'].includes(name) || options.has(name) || !value || value.startsWith('--')) {
      process.stderr.write(usage + '\n'); return 2;
    }
    options.set(name, value);
  }
  const root = options.get('--store'), ref = options.get('--credential-ref'), file = options.get('--file');
  if (!root || !isAbsolute(root) || root.includes('\0') || !ref || !isIdentifier(ref)
    || file !== undefined && (operation !== 'configure' || !isAbsolute(file) || file.includes('\0'))) {
    process.stderr.write(usage + '\n'); return 2;
  }
  try {
    const store = new FileCredentialStore(root, [new DeepSeekApiKeyCodec()]);
    const identity = { credentialRef: ref, service: 'deepseek', method: 'api-key' };
    let result;
    if (operation === 'configure') {
      if (file) result = await store.configure(identity, { file });
      else {
        const key = await readHiddenInput(); process.stderr.write('\n');
        result = await store.configure(identity, { content: JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: key }) });
      }
    } else if (operation === 'inspect') result = await store.inspect(identity);
    else result = await store.delete(identity);
    process.stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = error instanceof CredentialError ? error.code : error instanceof Error && /^AUTH_(INPUT|TERMINAL)_[A-Z_]+$/.test(error.message) ? error.message : 'AUTH_MANAGEMENT_FAILED';
    process.stderr.write(code + '\n'); return 1;
  }
}
