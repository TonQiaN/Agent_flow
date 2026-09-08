import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { authorizedHosts } from '../egress/proxy.js';
import { docker } from './process.js';

export interface DockerEgressOptions { readonly kind: 'connect-proxy'; readonly proxyImage: string; readonly allowedHosts: readonly string[] }
export function egressOptions(value: DockerEgressOptions): DockerEgressOptions {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'allowedHosts,kind,proxyImage'
    || value.kind !== 'connect-proxy' || typeof value.proxyImage !== 'string' || value.proxyImage.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9./_:@-]*$/.test(value.proxyImage) || /\s/.test(value.proxyImage)) throw new Error('INVALID_EGRESS_OPTIONS');
  return Object.freeze({ kind: 'connect-proxy', proxyImage: value.proxyImage, allowedHosts: authorizedHosts(value.allowedHosts) });
}

/** Owns only the proxy and networks belonging to one Runner resource. No provider logic or credentials. */
export class DockerEgress {
  readonly #id: string;
  readonly #directory: string;
  readonly #options: DockerEgressOptions;
  readonly #internal: string;
  readonly #external: string;
  readonly #proxy: string;
  #proxyImageId: string | null = null;
  #proxyAddress: string | null = null;
  constructor(id: string, directory: string, options: DockerEgressOptions) {
    this.#id = id; this.#directory = directory; this.#options = options;
    this.#internal = `${id}-internal`; this.#external = `${id}-external`; this.#proxy = `${id}-proxy`;
  }

  async setup(uid: number, gid: number): Promise<void> {
    const version = await docker(['version', '--format', '{{.Server.Version}}']);
    if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 28) throw new Error('EGRESS_REQUIRES_DOCKER_28');
    this.#proxyImageId = await docker(['image', 'inspect', '--format', '{{.Id}}', this.#options.proxyImage]);
    if (!/^sha256:[a-f0-9]{64}$/.test(this.#proxyImageId)) throw new Error('INVALID_PROXY_IMAGE');
    const source = await readFile(new URL('../egress/proxy.js', import.meta.url));
    const codePath = join(this.#directory, 'egress-proxy.mjs');
    await writeFile(codePath, source, { flag: 'wx', mode: 0o600 });
    await docker(['network', 'create', '--driver', 'bridge', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      '--label', `agentflow.resource=${this.#id}`, this.#internal]);
    const internal = await this.#network(this.#internal);
    if (!internal?.Internal || internal.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') throw new Error('EGRESS_ISOLATION_UNAVAILABLE');
    await docker(['network', 'create', '--driver', 'bridge', '--label', `agentflow.resource=${this.#id}`, this.#external]);
    await docker(['create', '--name', this.#proxy, '--label', `agentflow.resource=${this.#id}`, '--restart', 'no', '--init',
      '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64', '--network', this.#internal, '--log-driver', 'none',
      '--mount', `type=bind,src=${codePath},dst=/proxy.mjs,readonly`, '--entrypoint', 'node', this.#proxyImageId, '/proxy.mjs', ...this.#options.allowedHosts]);
    await this.#container();
    await docker(['network', 'connect', this.#external, this.#proxy]);
    await docker(['start', this.#proxy]);
    const address = await docker(['inspect', '--format', `{{with index .NetworkSettings.Networks "${this.#internal}"}}{{.IPAddress}}{{end}}`, this.#proxy]);
    if (!isIPv4(address)) throw new Error('INVALID_PROXY_ADDRESS');
    this.#proxyAddress = address;
    const probe = 'const s=require("net").connect(8080,"127.0.0.1",()=>s.end("GET / HTTP/1.1\\r\\nHost: health\\r\\nConnection: close\\r\\n\\r\\n"));s.setTimeout(1000,()=>process.exit(1));s.on("data",d=>process.exit(d.toString().startsWith("HTTP/1.1 405")?0:1));s.on("error",()=>process.exit(1));';
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.assertRunning();
      try { await docker(['exec', this.#proxy, 'node', '-e', probe], 2000); return; }
      catch { await delay(100); }
    }
    throw new Error('EGRESS_PROXY_NOT_READY');
  }

  arguments(): readonly string[] {
    if (!this.#proxyAddress) throw new Error('EGRESS_NOT_READY');
    const url = 'http://agentflow-egress:8080';
    return ['--network', this.#internal, '--dns', '127.0.0.1', '--add-host', `agentflow-egress:${this.#proxyAddress}`,
      ...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(name => ['--env', `${name}=${url}`]),
      '--env', 'NO_PROXY=', '--env', 'no_proxy='];
  }
  evidence(): { kind: 'connect-proxy'; proxyImageId: string | null; allowedHosts: readonly string[] } {
    return { kind: 'connect-proxy', proxyImageId: this.#proxyImageId, allowedHosts: this.#options.allowedHosts };
  }
  async assertRunning(): Promise<void> {
    if (!(await this.#container())?.Running) throw new Error('EGRESS_PROXY_STOPPED');
  }

  async #container(): Promise<{ Running: boolean } | null> {
    let raw: string;
    try { raw = await docker(['inspect', '--format', '{"owner":{{json (index .Config.Labels "agentflow.resource")}},"state":{{json .State}}}', this.#proxy]); }
    catch {
      const found = await docker(['container', 'ls', '--all', '--filter', `name=^/${this.#proxy}$`, '--format', '{{.ID}}']);
      if (!found) return null;
      throw new Error('EGRESS_INSPECT_FAILED');
    }
    const data = JSON.parse(raw) as { owner: string; state: { Running: boolean } };
    if (data.owner !== this.#id || typeof data.state?.Running !== 'boolean') throw new Error('EGRESS_OWNERSHIP_MISMATCH');
    return data.state;
  }
  async #network(name: string): Promise<{ Internal: boolean; Options: Record<string, string> | null } | null> {
    let raw: string;
    try { raw = await docker(['network', 'inspect', '--format', '{"owner":{{json (index .Labels "agentflow.resource")}},"Internal":{{.Internal}},"Options":{{json .Options}}}', name]); }
    catch {
      const found = await docker(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.ID}}']);
      if (!found) return null;
      throw new Error('EGRESS_NETWORK_INSPECT_FAILED');
    }
    const data = JSON.parse(raw) as { owner: string; Internal: boolean; Options: Record<string, string> | null };
    if (data.owner !== this.#id || typeof data.Internal !== 'boolean') throw new Error('EGRESS_OWNERSHIP_MISMATCH');
    return data;
  }

  /** Called only after the node container has been proved stopped and removed. */
  async remove(): Promise<void> {
    if (await this.#container()) await docker(['rm', '--force', this.#proxy]);
    if (await this.#container()) throw new Error('EGRESS_PROXY_NOT_REMOVED');
    for (const name of [this.#internal, this.#external]) {
      if (await this.#network(name)) await docker(['network', 'rm', name]);
      if (await this.#network(name)) throw new Error('EGRESS_NETWORK_NOT_REMOVED');
    }
  }
}
