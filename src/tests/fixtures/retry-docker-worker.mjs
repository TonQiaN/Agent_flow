import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {ContractRegistry,FileContractRegistry,ScriptExecutor,WorkflowRuntime,compileWorkflow,NodeWorker} from '@agentflow/engine';
import {DockerBackend,FileArtifactStore,FileArtifactArchive,FileWorkflowCatalog,SqliteRunRecordStore,PersistentNodeQueue,systemClock} from '@agentflow/integrations';
const [root,operation,worker='worker']=process.argv.slice(2);
const configuration={roles:{role:1},credentials:[],workflows:{retry:{a:{role:'role',capability:'docker'}}}};
const raw=await SqliteRunRecordStore.open(join(root,'queue')),queue=new PersistentNodeQueue(raw,configuration);
const host={open:async()=>{
 const contracts=new FileContractRegistry(new ContractRegistry());
 contracts.register('files',{rules:[{id:'value',kind:'file',match:'value.txt',minCount:1,maxCount:1,mediaTypes:['text/plain'],maxBytes:1000}],maxFiles:1,maxTotalBytes:1000,unmatched:'reject'});
 const artifacts=new FileArtifactStore(join(root,`temp-${worker}`),contracts),files=new FileWorkflowCatalog(contracts,artifacts,join(root,`work-${worker}`),new FileArtifactArchive(join(root,'archive'),contracts));
 const executor=new ScriptExecutor(new DockerBackend({workspaceRoot:join(root,'attempts'),image:'alpine:3'}),systemClock,{read:async file=>readFile(file.path,'utf8')});
 const execute=executor.execute.bind(executor);executor.execute=async(...args)=>{const attempt=await execute(...args);const facts=attempt.executionFacts();process.send({event:'capture',attempt:args[0].identity.attemptNumber,text:facts?.capture?await readFile(facts.capture.stdout.path,'utf8'):null});return attempt;};
 files.registerScript({id:'a',kind:'transform',implementation:'a',inputContract:'files',outcomes:{ok:'files'}},executor,{argv:['/bin/sh','-c',"set -eu; sleep 2; cat /task/input/value.txt; test ! -e /task/outputs/failed.txt; printf ':fresh'; printf changed > /task/input/value.txt; printf discarded > /task/outputs/failed.txt; exit 1"],timeoutMs:10000});
 const compiled=compileWorkflow({id:'retry',start:'a',maxSteps:1,input:{kind:'files',id:'files'},outcomes:{done:{kind:'files',id:'files'}},nodes:{a:{component:'a',retry:{maxAttempts:3,on:['execution_failure','interrupted'],delayMs:100}}},routes:[{from:'a',outcome:'ok',to:{end:'done'}}]},files);
 return {compiled,runtime:new WorkflowRuntime(),files,dispose:async snapshot=>{for(const step of snapshot?.steps??[])if(step.result.status==='failed')await files.cleanup(step.result.identity);}};
}};
try{
 if(operation==='prepare'){
  const a=await host.open();const input=await a.files.prepareInput('run',join(root,'source'),'files');await a.runtime.preparePersisted(a.compiled,'run',input,queue.records());await a.files.release(input,'run');process.send({event:'prepared'});
 }else{
  const bind=queue.bind.bind(queue);queue.bind=claim=>{const records=bind(claim);return {...records,compareAndSwap:async(...args)=>{const r=await records.compareAndSwap(...args),a=args[2].attempts?.at(-1);if(operation==='pause'&&a?.launch==='start_completed'&&a.resultStep===null&&!a.interrupted&&!a.retry){process.send({event:'running',resource:a.resource.resource,identity:a.identity});await new Promise(()=>{});}return r;}};};
  const w=new NodeWorker(queue,host,systemClock,worker,['docker'],900);const result=await w.runOnce();process.send({event:'done',result,tasks:await queue.query(),record:await queue.records().read('run')});
 }
}catch(e){process.send({error:e.code??e.message});process.exitCode=1;}
finally{raw.close();process.disconnect?.();}
