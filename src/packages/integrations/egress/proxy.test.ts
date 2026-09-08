import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import type { Server } from 'node:net';
import { once } from 'node:events';
import { authorizedHosts, createConnectProxy, publicIPv4 } from './proxy.js';
import type { ProxyTransport } from './proxy.js';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function exchange(port: number, request: string | Buffer): Promise<Buffer> {
  const socket = connect(port, '127.0.0.1'); const chunks: Buffer[] = [];
  socket.setTimeout(2000, () => socket.destroy(new Error('TEST_TIMEOUT')));
  socket.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  socket.once('connect', () => socket.end(request));
  await once(socket, 'close'); return Buffer.concat(chunks);
}
const forbiddenDial: ProxyTransport = { resolve: async () => { throw new Error('must-not-resolve'); }, dial: () => { throw new Error('must-not-dial'); } };

test('egress accepts exact DNS host declarations and blocks non-public address families', () => {
  assert.deepEqual(authorizedHosts(['auth.example.com']), ['auth.example.com']);
  for (const hosts of [[], ['localhost'], ['127.0.0.1'], ['*.example.com'], ['Example.com'], ['example.com.'], ['https://example.com'], ['u:p@example.com'], ['example.com', 'example.com']]) {
    assert.throws(() => authorizedHosts(hosts), /INVALID_EGRESS_HOSTS/);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '::1', '::ffff:8.8.8.8', '2606:4700::1111']) assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('1.1.1.1'), true); assert.equal(publicIPv4('8.8.8.8'), true);
});

test('CONNECT tunnel preserves buffered head and payload; dial receives checked address only', { timeout: 5000 }, async () => {
  const upstream = createServer(socket => socket.pipe(socket)); const upstreamPort = await listen(upstream);
  const called: unknown[] = [];
  const proxy = createConnectProxy(['allowed.example'], {
    resolve: async host => { called.push(host); return ['1.1.1.1']; },
    dial: (address, port) => { called.push([address, port]); return connect(upstreamPort, '127.0.0.1'); },
  });
  const port = await listen(proxy.server);
  try {
    const payload = Buffer.alloc(256 * 1024, 0xab);
    const response = await exchange(port, Buffer.concat([Buffer.from('CONNECT ALLOWED.EXAMPLE:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n'), payload]));
    const headerEnd = response.indexOf('\r\n\r\n') + 4;
    assert.match(response.subarray(0, headerEnd).toString(), /^HTTP\/1.1 200/);
    assert.deepEqual(response.subarray(headerEnd), payload);
    assert.deepEqual(called, ['allowed.example', ['1.1.1.1', 443]]);
  } finally { await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('HTTP, unknown hosts, IP literals and alternative ports cannot reach the resolver', async () => {
  const proxy = createConnectProxy(['allowed.example'], forbiddenDial); const port = await listen(proxy.server);
  try {
    for (const target of ['other.example:443', 'allowed.example:80', '127.0.0.1:443', 'allowed.example.:443', 'u:p@allowed.example:443']) {
      assert.match((await exchange(port, `CONNECT ${target} HTTP/1.1\r\nHost: irrelevant\r\n\r\n`)).toString(), /^HTTP\/1.1 403/);
    }
    assert.match((await exchange(port, 'GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n')).toString(), /^HTTP\/1.1 405/);
  } finally { await proxy.close(); }
});

test('DNS failures and mixed public/private answers fail without a second lookup or leaked error text', async () => {
  for (const resolve of [async () => ['127.0.0.1'], async () => ['1.1.1.1', '10.0.0.1'], async () => [], async () => { throw new Error('SYNTHETIC_PRIVATE_VALUE'); }]) {
    let dialed = false;
    const proxy = createConnectProxy(['allowed.example'], { resolve, dial: () => { dialed = true; throw new Error(); } });
    const port = await listen(proxy.server);
    try {
      const response = (await exchange(port, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n')).toString();
      assert.match(response, /^HTTP\/1.1 (403|502)/); assert.ok(!response.includes('SYNTHETIC_PRIVATE_VALUE')); assert.equal(dialed, false);
    } finally { await proxy.close(); }
  }
});

test('large or slow headers are bounded and stalled resolution retains its admission limit', { timeout: 5000 }, async () => {
  const proxy = createConnectProxy(['allowed.example'], { resolve: () => new Promise(() => {}), dial: forbiddenDial.dial },
    { connections: 1, headerMs: 100, connectMs: 40, idleMs: 100 });
  const port = await listen(proxy.server);
  try {
    assert.match((await exchange(port, `CONNECT allowed.example:443 HTTP/1.1\r\nX: ${'a'.repeat(9000)}\r\n\r\n`)).toString(), /^HTTP\/1.1 400/);
    const slow = connect(port, '127.0.0.1'); slow.on('error', () => {});
    await once(slow, 'connect'); slow.write('CONNECT ');
    await once(slow, 'close');
    assert.match((await exchange(port, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n')).toString(), /^HTTP\/1.1 504/);
    assert.match((await exchange(port, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n')).toString(), /^HTTP\/1.1 503/);
  } finally { await proxy.close(); }
});
