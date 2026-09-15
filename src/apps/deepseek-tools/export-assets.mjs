import { readFile } from 'node:fs/promises';

// Trusted deployment packaging only. No SDK imports or task-selected paths; stdout contains source assets, never credentials.
if (process.argv.length !== 2) throw new Error('ASSET_EXPORT_TAKES_NO_ARGUMENTS');
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
if (!Array.isArray(manifest.files) || manifest.files.length !== 13 || new Set(manifest.files).size !== 13
  || !manifest.files.every(name => /^[a-z][a-z-]*\.mjs$/.test(name))) throw new Error('INVALID_RUNTIME_MANIFEST');
const files = await Promise.all(manifest.files.map(async name => {
  const content = await readFile(new URL(name, import.meta.url), 'utf8');
  if (!content || Buffer.byteLength(content) > 65536 || content.includes('\0')) throw new Error('INVALID_RUNTIME_ASSET');
  return { name: `deepseek-policy/${name}`, content };
}));
process.stdout.write(JSON.stringify({ schema: 'agentflow-deepseek-assets/v1', version: '0.1.1-rc.2', files }));
