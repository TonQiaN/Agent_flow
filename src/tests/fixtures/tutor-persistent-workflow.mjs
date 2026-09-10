import { join } from 'node:path';
import { readFile, open } from 'node:fs/promises';
import { ScriptExecutor, EFFECT_RECEIPT_SCHEMA } from '@agentflow/engine';
import { DockerBackend, FileScriptRecordReader, systemClock, SqliteRunRecordStore, SqliteEffectRecordStore, FileCredentialStore, DeepSeekApiKeyCodec, DeepSeekApiKeyRunner, DeepSeekAgentDriver, CodexSubscriptionRunner, CodexSubscriptionCodec, CodexAgentDriver, ClaudeSubscriptionRunner, ClaudeSubscriptionCodec, ClaudeAgentDriver } from '@agentflow/integrations';
import { createPersistentGradingApplication } from '../../examples/tutor-grading/persistent.ts';
import { gradingComponent } from '../../examples/tutor-grading/flow.ts';
const [root,operation,variant,point,image,assetsPath,provider="deepseek"]=process.argv.slice(2);
const records=await SqliteRunRecordStore.open(join(root,'runs')),journal=await SqliteEffectRecordStore.open(join(root,'journal'));
const calls=[],approvals=[];let acquisitions=0,paused=false;
async function pause(at){if(!paused&&operation==='run'&&point===at){paused=true;process.send({point:at},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});}}
const store={create:records.create.bind(records),read:records.read.bind(records),compareAndSwap:async(...args)=>{
 const result=await records.compareAndSwap(...args),c=args[2],a=c.attempts?.at(-1),p=a?.phases?.at(-1);
 if(a?.resultStep===null){
  if(a.node==='marker'&&p?.id==='execution'&&p.launch==='start_completed')await pause('agent');
  if(a.node==='gate'&&a.launch==='start_completed')await pause('gate');
  if(a.node==='publish')await pause('before-publish');
 }return result;
}};
const log={identity:journal.identity,read:journal.read.bind(journal),create:journal.create.bind(journal),compareAndSwap:async(...args)=>{const result=await journal.compareAndSwap(...args);await pause('after-receipt');return result;}};
const subscription=provider!=='deepseek';
const actual=new FileCredentialStore(join(root,'credentials'),[subscription?(provider==='codex'?new CodexSubscriptionCodec():new ClaudeSubscriptionCodec()):new DeepSeekApiKeyCodec()]);
const source={acquire:async(...args)=>{acquisitions++;if(operation==='load')throw new Error('NO_LOAD_AUTH');return actual.acquire(...args);},inspect:actual.inspect.bind(actual),configure:actual.configure.bind(actual),delete:actual.delete.bind(actual)};
if(subscription){source.executionDefinition=actual.executionDefinition.bind(actual);source.acquireExecution=async(...args)=>{acquisitions++;if(operation==='load')throw new Error('NO_LOAD_AUTH');return actual.acquireExecution(...args);};source.finishExecution=actual.finishExecution.bind(actual);}
const adapter={implementation:'publish-impl',serviceIdentity:'fixture-publisher',definition:async()=>({schema:'fixture-local-publication/v1',targetFile:join(root,'external.jsonl')}),simulate:async()=>{throw new Error('NO_SIMULATE');},apply:async r=>{
 calls.push('publish');const file=await open(join(root,'external.jsonl'),'a',0o600);try{await file.writeFile(JSON.stringify(r)+'\n');await file.sync();}finally{await file.close();}
 await pause('after-effect');return {schema:EFFECT_RECEIPT_SCHEMA,requestId:r.requestId,componentId:r.componentId,target:r.target,key:r.key,serviceIdentity:r.serviceIdentity,mode:r.mode,status:'applied',reference:'local-record'};
}};
let app,run,loaded,snapshot,previousCount=0;
try{
 const options={workspaceRoot:join(root,'attempts'),image,proxyImage:'node:22-bookworm-slim'};
 const runtime=subscription?(provider==='codex'?new CodexSubscriptionRunner(source,options):new ClaudeSubscriptionRunner(source,options)):new DeepSeekApiKeyRunner(source,options,JSON.parse(await readFile(assetsPath,'utf8')));
 app=await createPersistentGradingApplication(root,'run',{records:store,...(operation==='run'?{source:join(root,'source')}:{ }),
  scripts:new ScriptExecutor(new DockerBackend({workspaceRoot:join(root,'script-attempts'),image:'node:22-bookworm-slim'}),systemClock,new FileScriptRecordReader()),
  driver:artifacts=>{const Driver=provider==='codex'?CodexAgentDriver:provider==='claude'?ClaudeAgentDriver:DeepSeekAgentDriver;const d=new Driver(runtime,artifacts,{id:'test',credentialRef:'fixture',service:provider==='codex'?'openai':provider==='claude'?'anthropic':'deepseek',method:subscription?'subscription':'api-key',endpoint:'official',capacity:subscription?1:null},{timeoutMs:20000});const invoke=d.run.bind(d);d.run=(...args)=>{calls.push(app.runtime.query('run').currentNode);return invoke(...args);};return d;},
  agents:[{component:gradingComponent('marker','agent','source-files',{completed:'candidate-files'}),prompt:variant==='correct'?'correct':variant==='source-tamper'?'source-tamper':'wrong',config:subscription?{model:'fixture-model',search:false,subagents:false}:{model:'deepseek-v4-flash',reasoning:'off',search:false,subagents:false}},
   {component:gradingComponent('fixer','agent','reviewed-files',{completed:'candidate-files'}),prompt:'correct',config:subscription?{model:'fixture-model',search:false,subagents:false}:{model:'deepseek-v4-flash',reasoning:'off',search:false,subagents:false}}],
  route:{id:'durable-tutor',marker:'marker',fixer:'fixer',repairs:variant==='no-repair'?0:1},
  publication:{target:'fixture-workout',key:variant==='key-drift'?'other-key':'fixture-publication',adapter,journal:log,allowApply:()=>{approvals.push('checked');return variant!=='no-approval';}}
 });
 if(operation==='load'){loaded=await app.load();snapshot=loaded.checkpoint.snapshot;}
 else if(operation==='resume'){const row=await records.read('run');previousCount=(row.content.checkpoint??row.content).snapshot.steps.length;run=await app.resume();snapshot=await run.completion;}
 else{run=await app.start();snapshot=await run.completion;}
 const converted=snapshot.steps.find(s=>s.node==='projection'&&s.result.status==='accepted')?.result;
 const receipt=converted?app.bridge.receipt(converted.identity):null;
 console.log(JSON.stringify({snapshot,calls,approvals,acquisitions,receipt,matches:converted?app.bridge.matches(converted.identity,converted.output):false,record:await records.read('run')}));
}catch(error){console.log(JSON.stringify({error:error.code??error.message,calls,approvals,acquisitions,record:await records.read('run')}));process.exitCode=1;}
finally{
 if(app?.input)await app.files.release(app.input,'run');
 if(snapshot&&operation!=='load')for(const step of snapshot.steps.slice(previousCount))if(step.result.status==='accepted'&&['intake','marker','gate','fixer'].includes(step.node))await app.files.release(step.result.output,'run');else if(step.result.status==='failed'){await app.files.cleanup(step.result.identity);await app.bridge.cleanup(step.result.identity);}
 await run?.dispose?.();await loaded?.dispose();records.close();journal.close();process.disconnect?.();
}
