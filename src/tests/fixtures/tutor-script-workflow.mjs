import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ScriptExecutor, WorkflowRuntime, compileWorkflow, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { DockerBackend, FileArtifactStore, FileArtifactArchive, FileWorkflowCatalog, SqliteRunRecordStore, systemClock } from '@agentflow/integrations';
import { gradingFileScripts } from '../../examples/tutor-grading/file-scripts.ts';
import { gradingContracts } from '../../examples/tutor-grading/contracts.ts';
import { prepareGradingSource, readGradingSource } from '../../examples/tutor-grading/source.ts';
const [root,operation,variant='wrong',interrupt='no']=process.argv.slice(2);
const contracts=gradingContracts(),artifacts=new FileArtifactStore(join(root,'temporary'),contracts.files),archive=new FileArtifactArchive(join(root,'archive'),contracts.files);
const files=new FileWorkflowCatalog(contracts.files,artifacts,join(root,'nodes'),archive),records=await SqliteRunRecordStore.open(join(root,'runs'));
let prepared;
const source=operation==='run'?(prepared=await prepareGradingSource(files,'run',join(root,'source'))).source:await readGradingSource('run',records,archive);
const scripts=await gradingFileScripts(source),started=[],restored=[];
if(operation==='source-drift')scripts.gate.argv[4]=JSON.stringify({files:source.files.map(f=>({...f,sha256:'f'.repeat(64)}))});
if(operation==='run'&&interrupt==='queued'){
 const create=records.create.bind(records);records.create=async(...args)=>{
  const result=await create(...args);process.send({point:'source-saved'},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});return result;
 };
}
if(operation==='run'&&interrupt==='yes'){
 const cas=records.compareAndSwap.bind(records);records.compareAndSwap=async(...args)=>{
  const record=await cas(...args),attempt=args[2].attempts?.at(-1);
  if(attempt?.node==='gate'&&attempt.identity.nodeTaskId==='task-3'&&attempt.launch==='start_completed'){
   process.send({point:'gate-running',resource:attempt.resource.resource},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});
  }return record;
 };
}
const candidate=async name=>readFile(new URL(`../../examples/tutor-grading/fixtures/${name}.json`,import.meta.url),'utf8');
const wrong=await candidate('wrong'),correct=await candidate('correct');
function canned(text,tamper=false){return {argv:['node','--input-type=module','-e',`import {cp,writeFile} from 'node:fs/promises'; await cp('/task/input','/task/outputs',{recursive:true}); await writeFile('/task/outputs/candidate.json',${JSON.stringify(text)}); ${tamper?"await writeFile('/task/outputs/source/key.json','{\"q1\":5,\"q2\":8,\"q3\":12}');":''} process.stdout.write(JSON.stringify({schema:'agentflow-script-result/v1',outcome:'completed'}));`],timeoutMs:30000};}
for(const [id,kind,inputContract,outcomes,definition] of [
 ['intake','transform','source-files',{completed:'source-files'},scripts.intake],
 ['marker','transform','source-files',{completed:'candidate-files'},canned(variant==='correct'?correct:wrong,variant==='source-tamper')],
 ['gate','gate','candidate-files',{passed:'reviewed-files',revise:'reviewed-files',rejected:'reviewed-files'},{...scripts.gate,argv:scripts.gate.argv.map((arg,i)=>i===3&&interrupt==='yes'?`await new Promise(resolve=>setTimeout(resolve,2500));\n${arg}`:arg)}],
 ['fixer','transform','reviewed-files',{completed:'candidate-files'},canned(correct)],
]){
 class Backend extends DockerBackend{
  async start(resource){await super.start(resource);started.push(id);}
  async restoreResource(...args){restored.push(id);return super.restoreResource(...args);}
 }
 const backend=new Backend({workspaceRoot:join(root,'attempts'),image:process.env.AGENTFLOW_TUTOR_SCRIPT_IMAGE??'node:22-bookworm-slim'});
 const executor=new ScriptExecutor(backend,systemClock,{read:async file=>readFile(file.path,'utf8')});
 files.registerScript({id,kind,inputContract,outcomes,implementation:`${id}-v1`},executor,definition);
}
const value={kind:'files',id:'source-files'},reviewed={kind:'files',id:'reviewed-files'};
const flow=compileWorkflow({id:'tutor-file-scripts',start:'intake',input:value,outcomes:{passed:reviewed,rejected:reviewed},maxSteps:8,
 nodes:{intake:{component:'intake'},marker:{component:'marker'},gate:{component:'gate'},fixer:{component:'fixer'}},routes:[
 {from:'intake',outcome:'completed',to:{node:'marker'}},{from:'marker',outcome:'completed',to:{node:'gate'}},{from:'gate',outcome:'passed',to:{end:'passed'}},{from:'gate',outcome:'rejected',to:{end:'rejected'}},
 {from:'gate',outcome:'revise',to:{node:'fixer'},limit:{max:1,exhausted:{end:'rejected'}}},{from:'fixer',outcome:'completed',to:{node:'gate'}}]},files);
let run,recovery,loaded,input,snapshot;
try{
 if(operation==='load'){loaded=await loadWorkflowCheckpoint(flow,'run',records);snapshot=loaded.checkpoint.snapshot;}
 else if(['resume','source-drift'].includes(operation)){recovery=await claimWorkflowRecovery(flow,'run',records);await recovery.cleanup();run=await new WorkflowRuntime().resumePersisted(recovery);snapshot=await run.completion;}
 else{input=prepared.input;run=await new WorkflowRuntime().startPersisted(flow,'run',input,records);snapshot=await run.completion;}
 let report=null,output=null;
 if(snapshot.lastAccepted?.result.status==='accepted'&&snapshot.lastAccepted.node==='gate'){
  const destination=join(root,`inspect-${process.pid}`);await files.materialize(snapshot.lastAccepted.result.output,'run',destination);report=JSON.parse(await readFile(join(destination,'gate-report.json'),'utf8'));output=JSON.parse(await readFile(join(destination,'candidate.json'),'utf8'));
 }
 console.log(JSON.stringify({snapshot,report,output,started,restored,record:await records.read('run')}));
}catch(error){console.log(JSON.stringify({error:error.code??error.message,started,restored}));process.exitCode=1;}
finally{
 if(input)await files.release(input,'run');
 if(snapshot&&operation!=='load')for(const step of snapshot.steps.slice(recovery?.query().checkpoint.snapshot.steps.length??0))if(step.result.status==='accepted')await files.release(step.result.output,'run');else await files.cleanup(step.result.identity);
 await run?.dispose?.();await recovery?.dispose();await loaded?.dispose();records.close();process.disconnect?.();
}
