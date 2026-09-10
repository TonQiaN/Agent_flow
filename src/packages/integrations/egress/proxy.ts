import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect, isIPv4, isIP } from 'node:net';
import type { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

export function authorizedHosts(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16 || values.some(host => typeof host !== 'string'
    || host.length > 253 || host !== host.toLowerCase() || !host.includes('.') || isIP(host) !== 0
    || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    || new Set(values).size !== values.length) throw new Error('INVALID_EGRESS_HOSTS');
  return Object.freeze([...values]);
}

export function publicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

export interface ProxyTransport {
  resolve(host: string): Promise<readonly string[]>;
  dial(address: string, port: number): Socket;
}
export interface ProxyLimits { readonly connections: number; readonly headerMs: number; readonly connectMs: number; readonly idleMs: number }
const defaults: ProxyLimits = { connections: 32, headerMs: 5000, connectMs: 10_000, idleMs: 300_000 };
const direct: ProxyTransport = {
  resolve: async host => (await lookup(host, { family: 4, all: true })).map(result => result.address),
  dial: (address, port) => connect({ host: address, port, family: 4 }),
};

/** CONNECT only. Test transports substitute IO, never the policy check before dial. */
export function createConnectProxy(hosts: readonly string[], transport: ProxyTransport = direct, limits: ProxyLimits = defaults): { server: Server; close(): Promise<void> } {
  const allowed = new Set(authorizedHosts(hosts));
  if (!Number.isSafeInteger(limits.connections) || limits.connections < 1 || limits.connections > 256
    || [limits.headerMs, limits.connectMs, limits.idleMs].some(ms => !Number.isSafeInteger(ms) || ms < 1 || ms > 300_000)) throw new Error('INVALID_PROXY_LIMITS');
  const options = Object.freeze({ ...limits });
  const sockets = new Set<Socket>();
  const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
  let resolving = 0;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: options.headerMs, requestTimeout: options.headerMs }, (_request, response) => {
    response.writeHead(405, { Connection: 'close', 'Content-Length': '0' }); response.end();
  });
  server.maxConnections = options.connections;
  const refuse = (socket: Socket, status: number): void => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  server.on('connection', socket => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), options.headerMs);
    headerTimers.set(socket, timer);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); headerTimers.delete(socket); sockets.delete(socket); });
  });
  server.on('clientError', (_error, socket) => refuse(socket as Socket, 400));
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (request, stream, head) => {
    const client = stream as Socket;
    clearTimeout(headerTimers.get(client)); headerTimers.delete(client);
    client.pause();
    const match = /^([A-Za-z0-9.-]+):443$/.exec(request.url ?? '');
    const host = match?.[1]?.toLowerCase();
    if (!host || !allowed.has(host)) { refuse(client, 403); return; }
    if (resolving >= options.connections) { refuse(client, 503); return; }
    resolving++;
    let upstream: Socket | undefined;
    let expired = false;
    let connected = false;
    const timer = setTimeout(() => { expired = true; upstream?.destroy(); refuse(client, 504); }, options.connectMs);
    client.once('close', () => { clearTimeout(timer); upstream?.destroy(); });
    void (async () => {
      let addresses: readonly string[];
      try { addresses = await transport.resolve(host); }
      catch { clearTimeout(timer); refuse(client, 502); return; }
      finally { resolving--; }
      if (expired || client.destroyed) return;
      if (!addresses.length || addresses.some(address => !publicIPv4(address))) { clearTimeout(timer); refuse(client, 403); return; }
      try { upstream = transport.dial(addresses[0]!, 443); }
      catch { clearTimeout(timer); refuse(client, 502); return; }
      sockets.add(upstream);
      const peer = upstream;
      peer.once('close', error => { sockets.delete(peer); if (connected) { if (error) client.destroy(); else client.end(); } });
      peer.on('error', () => { clearTimeout(timer); if (connected) client.destroy(); else refuse(client, 502); peer.destroy(); });
      peer.once('connect', () => {
        if (expired || client.destroyed) { peer.destroy(); return; }
        connected = true; clearTimeout(timer);
        client.setTimeout(options.idleMs, () => client.destroy());
        peer.setTimeout(options.idleMs, () => peer.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Bytes already read after the CONNECT header are part of the tunnel, not another HTTP request.
        if (head.length) peer.write(head);
        peer.pipe(client); client.pipe(peer); client.resume();
      });
    })().catch(() => { clearTimeout(timer); upstream?.destroy(); client.destroy(); });
  });
  return { server, close: async () => {
    for (const socket of sockets) socket.destroy();
    for (const timer of headerTimers.values()) clearTimeout(timer);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

// This module is also copied verbatim as a standalone .mjs into the trusted proxy container.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const proxy = createConnectProxy(process.argv.slice(2));
    proxy.server.on('error', () => { process.stderr.write('EGRESS_PROXY_FAILED\n'); process.exitCode = 1; });
    proxy.server.listen(8080, '0.0.0.0');
    process.once('SIGTERM', () => { void proxy.close().catch(() => { process.exitCode = 1; }); });
  } catch { process.stderr.write('INVALID_EGRESS_CONFIGURATION\n'); process.exitCode = 1; }
}
