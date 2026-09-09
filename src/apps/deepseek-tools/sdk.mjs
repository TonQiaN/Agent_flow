import { createRequire } from 'node:module';

// This application runs only inside the verified image. No caller can choose the installation root or a module name.
const nativeRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
if (nativeRequire('./package.json').version !== '0.1.1-rc.2'
  || nativeRequire('@deepseek-ai/cordis/package.json').version !== '4.0.1'
  || nativeRequire('@deepseek-ai/dsh-fs/package.json').version !== '0.1.1-rc.2'
  || nativeRequire('@deepseek-ai/dsh-tools/package.json').version !== '0.1.1-rc.2'
  || nativeRequire('@deepseek-ai/dsh-fs-local/package.json').version !== '0.1.1-rc.2') throw new Error('UNSUPPORTED_DEEPSEEK_TOOL_SDK');
export const { Context, Service } = await import(nativeRequire.resolve('@deepseek-ai/cordis'));
export const { FileSystem, FsError } = await import(nativeRequire.resolve('@deepseek-ai/dsh-fs'));
export const { LocalFileSystem } = await import(nativeRequire.resolve('@deepseek-ai/dsh-fs-local'));
export const { defineTool } = await import(nativeRequire.resolve('@deepseek-ai/dsh-tools'));
