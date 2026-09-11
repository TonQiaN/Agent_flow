import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerBackend } from './backend.js';

for (const stale of ['running', 'created']) for (const final of ['exited', 'running', 'unknown']) {
  test(`Docker observation reconciles stale ${stale} after attach close with ${final}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'af-observe-race-'));
    const previous = process.env['PATH'];
    try {
      await mkdir(join(root, 'input'));
      await writeFile(join(root, 'docker'), `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const root=${JSON.stringify(root)};
const args=process.argv.slice(2);const file=n=>path.join(root,n);
const wait=async n=>{const until=Date.now()+5000;while(!fs.existsSync(file(n))){if(Date.now()>until)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,5));}};
(async()=>{
 if(args[0]==='start'){await wait('snapshot');process.exit(0);}
 if(args[0]==='inspect'){
  let count=0;try{count=Number(fs.readFileSync(file('count'),'utf8'));}catch{}
  fs.writeFileSync(file('count'),String(++count));
  if(count===2){fs.writeFileSync(file('snapshot'),'');await wait('disposed');}
  if(count>2&&${JSON.stringify(final)}==='unknown')process.exit(1);
  const status=count===1?'created':count===2?${JSON.stringify(stale)}:${JSON.stringify(final)};
  process.stdout.write(JSON.stringify({labels:{'agentflow.resource':args.at(-1)},state:{Status:status,Running:status==='running',ExitCode:0}}));
 }else if(args[0]==='container')process.exit(1);
})().catch(()=>process.exit(1));
`, { mode: 0o700 });
      process.env['PATH'] = root + ':' + previous;
      const backend = new DockerBackend({ workspaceRoot: join(root, 'attempts'), image: 'fixture:image' }, undefined, {
        open(input) { input.end(); return () => writeFileSync(join(root, 'disposed'), ''); }, output() {},
      });
      const resource = await backend.allocate();
      await backend.prepare(resource, { inputSource: join(root, 'input'), timeoutMs: 5000,
        identity: { runId: 'run', nodeTaskId: 'node', attemptId: 'attempt', attemptNumber: 1 }, invocation: { argv: ['/bin/true'] } });
      await backend.start(resource);
      if (final === 'exited') assert.deepEqual(await backend.observe(resource), { state: 'exited', exitCode: 0 });
      else await assert.rejects(backend.observe(resource), { message: final === 'running' ? 'ATTACH_ENDED_EARLY' : 'DOCKER_COMMAND_FAILED' });
    } finally {
      if (previous === undefined) delete process.env['PATH']; else process.env['PATH'] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
