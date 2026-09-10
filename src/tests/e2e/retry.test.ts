import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {docker} from '../../packages/integrations/docker/process.js';
const enabled=process.env['AGENTFLOW_DOCKER_TESTS']==='1';
function child(root:string,operation:string,worker=operation){
 const p=fork(new URL('../fixtures/retry-docker-worker.mjs',import.meta.url),[root,operation,worker],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';p.stderr!.on('data',b=>stderr+=b);p.stdout!.resume();const messages:any[]=[];p.on('message',m=>messages.push(m));
 const timer=setTimeout(()=>p.kill('SIGKILL'),25000),exited=once(p,'exit').finally(()=>clearTimeout(timer));
 const next=async()=>{for(;;){if(messages.length)return messages.shift();await Promise.race([once(p,'message'),exited.then(()=>{if(!messages.length)throw new Error(stderr||'early exit');})]);}};
 return {p,exited,next};
}
async function complete(root:string,operation:string,worker=operation){const c=child(root,operation,worker),messages:any[]=[];for(;;){const m=await c.next();messages.push(m);if(m.event==='done'||m.event==='prepared'||m.error)break;}assert.deepEqual(await c.exited,[0,null],JSON.stringify(messages));return messages;}
for(const killedAttempt of [2,3])test(`durable Docker retry: SIGKILL Attempt ${killedAttempt} never permits Attempt 4 and preserves original files`,{skip:!enabled,timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'af-retry-docker-'));await mkdir(join(root,'source'));await writeFile(join(root,'source/value.txt'),'seed');
 let old:ReturnType<typeof child>|undefined,id:string|undefined;
 try{
  await complete(root,'prepare');
  for(let attempt=1;attempt<killedAttempt;attempt++){
   const all=await complete(root,'once',`first-${attempt}`),done=all.at(-1);
   assert.equal(done.result.error,null);assert.equal(done.result.waiting,'RETRY_WAIT');assert.equal(done.result.snapshot.retry.attemptNumber,attempt);
   assert.equal(all.find(m=>m.event==='capture').text,'seed:fresh');assert.equal(done.tasks[0].owner,null);
  }
  old=child(root,'pause');const started=await old.next();assert.equal(started.identity.attemptNumber,killedAttempt);id=started.resource.id;
  assert.equal(JSON.parse(await docker(['inspect',id!]))[0].State.Running,true);
  old.p.kill('SIGKILL');assert.deepEqual(await old.exited,[null,'SIGKILL']);
  await new Promise(r=>setTimeout(r,1000));
  let all=await complete(root,'resume'),done=all.at(-1);assert.equal(done.result.error,null);await assert.rejects(docker(['inspect',id!]));
  assert.equal(done.record.content.attempts.length,killedAttempt);
  if(killedAttempt===2){
   assert.equal(done.result.waiting,'RETRY_WAIT');assert.equal(done.record.content.attempts[1].retry.result.code,'ATTEMPT_INTERRUPTED');
   all=await complete(root,'third');done=all.at(-1);assert.equal(all.find(m=>m.event==='capture').text,'seed:fresh');assert.equal(done.result.snapshot.reason,'SCRIPT_EXECUTION_FAILED');
  }else assert.equal(done.result.snapshot.reason,'ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(done.result.snapshot.status,'failed');assert.equal(done.record.content.attempts.length,3);assert.equal(done.record.content.values.length,1);
  assert.deepEqual(done.record.content.attempts.map((a:any)=>a.identity.attemptNumber),[1,2,3]);
  assert.ok(done.record.content.attempts.every((a:any)=>a.identity.nodeTaskId==='task-1'));
  assert.equal((await complete(root,'fourth')).at(-1).result,null);assert.equal(await readFile(join(root,'source/value.txt'),'utf8'),'seed');
 }finally{if(old&&old.p.exitCode===null&&old.p.signalCode===null){old.p.kill('SIGKILL');await old.exited;}if(id)await docker(['rm','-f',id]).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
