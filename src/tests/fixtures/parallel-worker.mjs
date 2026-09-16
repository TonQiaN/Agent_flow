import {join} from 'node:path';
import {appendFile} from 'node:fs/promises';
import {NodeWorker} from '@agentflow/engine';
import {SqliteRunRecordStore,PersistentNodeQueue,systemClock} from '@agentflow/integrations';
import {application} from './parallel-workflow.mjs';
const [root,operation,worker='worker',leaseMs='900',finishPauseMs='0']=process.argv.slice(2);
const app=application({observe:async({component,input,identity,cancel})=>{
 await appendFile(join(root,'calls.jsonl'),JSON.stringify({component,id:input.id??null,identity})+'\n',{mode:0o600});
 if(operation==='hold'&&component!=='finish'){process.send({event:'executing',id:input.id,identity});await new Promise(resolve=>process.once('message',resolve));
  // Capacity tests model a busy host separately from deliberate lease-expiry tests.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(finishPauseMs));}
}});
const raw=await SqliteRunRecordStore.open(join(root,'db')),queue=new PersistentNodeQueue(raw,app.configuration);
try{
 if(operation==='prepare'){await app.runtime.preparePersisted(app.compiled,'run',[{id:'a',value:1},{id:'b',value:2},{id:'c',value:3}],queue.records());process.send({event:'prepared'});}
 else{
  if(operation==='hold-expand'){
   const bind=queue.bind.bind(queue);queue.bind=claim=>{const records=bind(claim);return{...records,parallel:{...records.parallel,expand:async(...args)=>{const result=await records.parallel.expand(...args);process.send({event:'expanded'});await new Promise(()=>{});return result;}}};};
  }
  const result=await new NodeWorker(queue,{open:app.open},systemClock,worker,['json'],Number(leaseMs)).runOnce();process.send({event:'done',result,tasks:await queue.query(),record:await queue.records().read('run')});
 }
}catch(e){process.send({error:e.code??e.message});process.exitCode=1;}
finally{raw.close();process.disconnect?.();}
