import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
export interface StudioConfig { harness: 'deepseek' | 'codex' | 'claude'; credentialStore: string; credentialRef: string; model: string; image: string; proxyImage: string; documentsImage: string; tutorWorkspace?: string; tutorPython?: string }
export async function configuration(dataRoot: string): Promise<StudioConfig> {
  let file: Partial<StudioConfig> = {}; try { file = JSON.parse(await readFile(join(dataRoot, 'config.json'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本机 config.json 无法读取'); }
  const harness = file.harness ?? 'deepseek'; if (!['deepseek', 'codex', 'claude'].includes(harness)) throw new Error('不支持的模型执行器');
  return { harness, credentialStore: resolve(file.credentialStore ?? join(dataRoot, 'credentials')), credentialRef: file.credentialRef ?? 'default', model: file.model ?? (harness === 'deepseek' ? 'deepseek-flash' : 'gpt-6-astra'), image: file.image ?? (harness === 'deepseek' ? 'agentflow/studio-deepseek:0.1.1-rc.2' : harness === 'codex' ? 'agentflow/studio-codex:0.153.4' : 'agentflow/studio-claude:configured'), proxyImage: file.proxyImage ?? 'node:22-bookworm-slim', documentsImage: file.documentsImage ?? 'agentflow/studio-documents:issue39', ...(file.tutorWorkspace ? { tutorWorkspace: resolve(file.tutorWorkspace) } : {}), ...(file.tutorPython ? { tutorPython: resolve(file.tutorPython) } : {}) };
}
export function environment(config: StudioConfig, root: string): NodeJS.ProcessEnv {
  return { ...process.env, AGENTFLOW_STUDIO_RUN_ROOT: root, AGENTFLOW_CREDENTIAL_STORE: config.credentialStore, AGENTFLOW_CREDENTIAL_REF: config.credentialRef, AGENTFLOW_STUDIO_HARNESS: config.harness, [`AGENTFLOW_${config.harness.toUpperCase()}_IMAGE`]: config.image, [`AGENTFLOW_${config.harness.toUpperCase()}_MODEL`]: config.model, AGENTFLOW_PROXY_IMAGE: config.proxyImage, AGENTFLOW_DOCUMENTS_IMAGE: config.documentsImage, ...(config.tutorWorkspace ? { TUTOR_WORKSPACE: config.tutorWorkspace } : {}), ...(config.tutorPython ? { TUTOR_PYTHON: config.tutorPython } : {}) };
}
export async function prerequisites(config: StudioConfig) {
  const exec = promisify(execFile), probe = async (args: string[]) => { try { await exec('docker', args, { timeout: 8000 }); return true; } catch { return false; } };
  const [docker, documents, harnessImage, proxy, tutor] = await Promise.all([probe(['info', '--format', '{{.ServerVersion}}']), probe(['image', 'inspect', config.documentsImage]), probe(['image', 'inspect', config.image]), probe(['image', 'inspect', config.proxyImage]), config.tutorWorkspace && config.tutorPython ? Promise.all([access(config.tutorWorkspace), access(config.tutorPython)]).then(() => true, () => false) : false]);
  return { docker, documents, harness: harnessImage && proxy || process.env['AGENTFLOW_STUDIO_FIXTURE'] === '1', tutor: Boolean(tutor) };
}
