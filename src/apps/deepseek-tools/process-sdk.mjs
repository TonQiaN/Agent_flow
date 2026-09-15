import { createRequire } from 'node:module';
const nativeRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
if (nativeRequire('@deepseek-ai/dsh-subprocess-local/package.json').version !== '0.1.1-rc.2'
  || nativeRequire('@deepseek-ai/dsh-bash-local/package.json').version !== '0.1.1-rc.2'
  || nativeRequire('@deepseek-ai/dsh-sandbox-policy/package.json').version !== '0.1.1-rc.2') throw new Error('UNSUPPORTED_DEEPSEEK_PROCESS_SDK');
export const { LocalSubprocessRuntime } = await import(nativeRequire.resolve('@deepseek-ai/dsh-subprocess-local'));
export const { LocalBashExecutor } = await import(nativeRequire.resolve('@deepseek-ai/dsh-bash-local'));
export const { effectiveSandboxMode } = await import(nativeRequire.resolve('@deepseek-ai/dsh-sandbox-policy'));
