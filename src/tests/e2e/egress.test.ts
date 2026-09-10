import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Runner } from '@agentflow/engine';
import type { ExecutionResource, RunnerResult } from '@agentflow/engine';
import { DockerBackend, systemClock } from '@agentflow/integrations';

const enabled = process.env['AGENTFLOW_EGRESS_TESTS'] === '1';
const image = process.env['AGENTFLOW_PROXY_IMAGE'] ?? 'node:22-bookworm-slim';
const realTest = (name: string, body: () => Promise<void>) => test(name, { skip: !enabled, timeout: 60_000 }, body);
async function fixture(proxyImage = image) {
  const root = await mkdtemp(join(tmpdir(), 'af-egress-test-')); const input = join(root, 'input'); await mkdir(input);
  let allocated: ExecutionResource | undefined;
  class ObservedBackend extends DockerBackend {
    override async allocate(): Promise<ExecutionResource> { allocated = await super.allocate(); return allocated; }
  }
  const backend = new ObservedBackend({ workspaceRoot: join(root, 'attempts'), image, network: { kind: 'connect-proxy', proxyImage, allowedHosts: ['example.com'] } });
  const runner = new Runner(backend, systemClock);
  const request = (script: string, timeoutMs = 20_000) => ({ identity: { runId: 'egress-test', nodeTaskId: 'task', attemptId: 'attempt', attemptNumber: 1 },
    inputSource: input, timeoutMs, invocation: { argv: ['node', '-e', script] } });
  return { runner, backend, request, resource: () => allocated, cleanup: async (result: RunnerResult) => {
    if (result.resource) {
      if (result.cleanup !== 'removed') { assert.equal((await backend.stop(result.resource)).confirmed, true); await backend.remove(result.resource); }
      await runner.release(result.resource);
    }
    await rm(root, { recursive: true, force: true });
  } };
}
function assertRemoved(id: string): void {
  for (const command of [['container', 'ls', '--all'], ['network', 'ls']]) {
    assert.equal(execFileSync('docker', [...command, '--filter', `label=agentflow.resource=${id}`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim(), '');
  }
}
async function waitRunning(id: () => ExecutionResource | undefined): Promise<string> {
  for (let step = 0; step < 100; step++) {
    const resource = id();
    if (resource) {
      try { if (execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', resource.id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true') return resource.id; }
      catch { /* Not created yet. */ }
    }
    await delay(50);
  }
  throw new Error('NODE_DID_NOT_START');
}

realTest('Egress: actual TLS works through the authorized proxy while direct traffic, DNS and other targets fail', async () => {
  const f = await fixture();
  const script = `
const http=require('http'),tls=require('tls'),net=require('net'),dns=require('dns').promises,fs=require('fs');
const proxy=new URL(process.env.HTTPS_PROXY);
function tunnel(target){return new Promise((resolve,reject)=>{const r=http.request({host:proxy.hostname,port:proxy.port,method:'CONNECT',path:target});r.on('connect',(res,socket)=>resolve({status:res.statusCode,socket}));r.on('error',reject);r.setTimeout(5000,()=>r.destroy(new Error('CONNECT_TIMEOUT')));r.end();});}
function blocked(host,port){return new Promise(resolve=>{const s=net.connect(port,host);s.setTimeout(500,()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(true));s.once('connect',()=>{s.destroy();resolve(false)});});}
(async()=>{
 const directBlocked=await blocked('1.1.1.1',443);
 const resolver=new dns.Resolver({timeout:300,tries:1});let dnsBlocked=false;
 try{await resolver.resolve4('example.com')}catch{dnsBlocked=true}
 const unknown=await tunnel('example.net:443');unknown.socket.destroy();
 const ip=await tunnel('127.0.0.1:443');ip.socket.destroy();
 const target=await tunnel('example.com:443');if(target.status!==200)throw new Error('APPROVED_CONNECT_'+target.status);
 const reply=await new Promise((resolve,reject)=>{const s=tls.connect({socket:target.socket,servername:'example.com',rejectUnauthorized:true},()=>s.write('HEAD / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n'));let data='';s.setTimeout(5000,()=>s.destroy(new Error('TLS_TIMEOUT')));s.on('data',c=>{data+=c.toString();if(data.length>16384)s.destroy(new Error('HEADER_LIMIT'))});s.on('error',reject);s.on('end',()=>resolve(data.split('\\r\\n')[0]));});
 const report={directBlocked,dnsBlocked,unknownDenied:unknown.status===403,ipDenied:ip.status===403,tlsVerified:/^HTTP\\/1\\.[01] [1-5][0-9][0-9]/.test(reply)};
 if(Object.values(report).some(x=>x!==true))throw new Error('NETWORK_BOUNDARY_FAILED');
 fs.writeFileSync('/task/outputs/network.json',JSON.stringify(report));console.log('egress_verified');
})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  const result = await f.runner.run(f.request(script));
  try {
    const stderr = result.capture?.stderr.complete ? await readFile(result.capture.stderr.path, 'utf8') : '';
    assert.equal(result.exitCode, 0, JSON.stringify({ phase: result.phase, diagnostics: result.diagnostics, stderr }));
    assert.equal(result.cleanup, 'removed');
    assert.deepEqual(JSON.parse(await readFile(join(result.capture!.outputsPath, 'network.json'), 'utf8')),
      { directBlocked: true, dnsBlocked: true, unknownDenied: true, ipDenied: true, tlsVerified: true });
    assert.deepEqual(result.capture!.network?.allowedHosts, ['example.com']);
    assert.match(result.capture!.network!.proxyImageId!, /^sha256:[a-f0-9]{64}$/);
    assertRemoved(result.resource!.id);
  } finally { await f.cleanup(result); }
});

realTest('Egress: cancellation and proxy failure stop the node and clean up owned network resources', async () => {
  for (const mode of ['cancel', 'proxy_failure'] as const) {
    const f = await fixture(); let cancelled = false;
    const pending = f.runner.run(f.request('setInterval(()=>{},1000)'), { requested: () => cancelled });
    let result: RunnerResult;
    try {
      const id = await waitRunning(f.resource);
      if (mode === 'cancel') cancelled = true;
      else execFileSync('docker', ['kill', `${id}-proxy`], { stdio: 'ignore' });
      result = await pending;
    } catch (error) { cancelled = true; result = await pending; await f.cleanup(result); throw error; }
    try {
      assert.equal(result.phase, mode === 'cancel' ? 'cancelled' : 'failed');
      if (mode === 'proxy_failure') assert.ok(result.diagnostics.includes('OBSERVE_FAILED'));
      assert.equal(result.stop, 'confirmed'); assert.equal(result.cleanup, 'removed'); assertRemoved(result.resource!.id);
    } finally { await f.cleanup(result); }
  }
});

realTest('Egress: partial proxy startup failure leaves no container or network behind', async () => {
  const f = await fixture('alpine:3'); // Deliberately lacks the required Node executable.
  const result = await f.runner.run(f.request('console.log("must-not-start")'));
  try {
    assert.equal(result.phase, 'failed'); assert.ok(result.diagnostics.includes('CREATE_FAILED'));
    assert.equal(result.cleanup, 'removed'); assert.equal(result.exitCode, null); assertRemoved(result.resource!.id);
  } finally { await f.cleanup(result); }
});
