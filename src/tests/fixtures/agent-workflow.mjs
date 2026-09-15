import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ContractRegistry, FileContractRegistry, AgentExecutor, compileWorkflow, WorkflowRuntime, loadWorkflowCheckpoint, claimWorkflowRecovery } from '@agentflow/engine';
import { FileCredentialStore, DeepSeekApiKeyCodec, DeepSeekApiKeyRunner, DeepSeekAgentDriver, FileArtifactStore, FileArtifactArchive, FileWorkflowCatalog, SqliteRunRecordStore } from '@agentflow/integrations';
const [root, operation, stage, image, assetsPath] = process.argv.slice(2);
const credential = { credentialRef: 'fixture', service: 'deepseek', method: 'api-key' }, profile = { id: 'test', ...credential, endpoint: 'official', capacity: null };
let credentialCalls = 0;
const actual = new FileCredentialStore(join(root, 'credentials'), [new DeepSeekApiKeyCodec()]);
const source = { acquire: async (...args) => { credentialCalls++; if (operation === 'load') throw new Error('NO_CREDENTIAL_READ'); return actual.acquire(...args); },
  inspect: async () => { throw new Error('NO_INSPECT'); }, configure: async () => { throw new Error('NO_CONFIGURE'); }, delete: async () => { throw new Error('NO_DELETE'); } };
const json = new ContractRegistry();
json.register('input', { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'], additionalProperties: false });
json.register('answer', { type: 'object', properties: { sum: { type: 'integer', const: 6 } }, required: ['sum'], additionalProperties: false });
const contracts = new FileContractRegistry(json);
for (const [id, path] of [['input','numbers.json'],['answer','answer.json']]) contracts.register(id, { rules: [{ id, kind: 'file', match: path, minCount: 1, maxCount: 1, mediaTypes: ['application/json'], maxBytes: 1024, jsonContract: id }], maxFiles: 1, maxTotalBytes: 1024, unmatched: 'reject' });
const artifacts = new FileArtifactStore(join(root, 'artifacts'), contracts), archive = new FileArtifactArchive(join(root, 'archive'), contracts);
const runtime = new DeepSeekApiKeyRunner(source, { workspaceRoot: join(root, 'attempts'), image, proxyImage: 'node:22-bookworm-slim' }, JSON.parse(await readFile(assetsPath,'utf8')));
const driver = new DeepSeekAgentDriver(runtime, artifacts, profile, { timeoutMs: 15000 });
const executor = new AgentExecutor(contracts, artifacts, driver), catalog = new FileWorkflowCatalog(contracts, artifacts, join(root, 'work'), archive);
const calls=[]; const execute = catalog.execute.bind(catalog); catalog.execute = (...args) => { calls.push(args[0].id); return execute(...args); };
for (const id of ['a','b']) catalog.registerAgent({ id, kind:'agent', implementation:id,inputContract:id==='a'?'input':'answer',outcomes:{ok:'answer'}},executor,{prompt: (operation === 'failure' || stage === 'failure') && id === 'b' ? 'nonzero' : 'normal',config:{model:'deepseek-v4-flash',reasoning:'off',search:false,subagents:false}});
const value={kind:'files',id:'answer'};
const flow=compileWorkflow({id:'agents',start:'a',input:{kind:'files',id:'input'},maxSteps:2,outcomes:{done:value},nodes:{a:{component:'a'},b:{component:'b'}},routes:[{from:'a',outcome:'ok',to:{node:'b'}},{from:'b',outcome:'ok',to:{end:'done'}}]},catalog);
const db=await SqliteRunRecordStore.open(join(root,'db'));let paused=false;
const store={create:db.create.bind(db),read:db.read.bind(db),compareAndSwap:async(id,revision,content)=>{
 const a=content.schema==='agentflow-workflow-checkpoint/v5'?content.attempts.findLast(a=>!a.interrupted&&a.resultStep===null):null,p=a?.phases?.at(-1);
 const matches=a&&p&&`${a.node}:${p.id}`===stage&&(p.kind==='operation'?p.status==='active':p.status==='active'&&p.launch==='start_completed');
 if ((operation === 'reject' && matches && p.kind === 'operation') || (operation === 'reject-complete' && a && p && `${a.node}:${p.id}` === stage && p.status === 'completed')) throw new Error('INJECTED_PHASE_WRITE_FAILURE');
 const result=await db.compareAndSwap(id,revision,content);
 if(!paused&&['run','resume-pause'].includes(operation)&&matches){paused=true;process.send({event:'paused',identity:a.identity,credentialCalls});await new Promise(()=>setInterval(()=>{},1000));}
 return result;
}};
try{
 if(operation==='load'){const loaded=await loadWorkflowCheckpoint(flow,'run',store);const output=loaded.checkpoint.snapshot.lastAccepted?.result.output; if(output)await catalog.materialize(output,'run',join(root,'loaded-output'));process.stdout.write(JSON.stringify({checkpoint:loaded.checkpoint,credentialCalls,calls}));await loaded.dispose();}
 else{
 let handle;
 if(['run','reject','reject-complete','normal','failure'].includes(operation)){const input=await catalog.prepareInput('run',join(root,'source'),'input');handle=await new WorkflowRuntime().startPersisted(flow,'run',input,store);}
 else{const recovery=await claimWorkflowRecovery(flow,'run',store);await recovery.cleanup();if(credentialCalls)throw new Error('RECOVERY_ACCESSED_CREDENTIALS');handle=await new WorkflowRuntime().resumePersisted(recovery);}
 const result=await handle.completion;
 if (operation === 'failure') { if (result.status !== 'failed') throw new Error('EXPECTED_FAILURE'); await catalog.cleanup(result.currentIdentity); }
 if(result.status==='succeeded')await catalog.materialize(result.lastAccepted.result.output,'run',join(root,'result-output'));
 process.stdout.write(JSON.stringify({result,credentialCalls,calls}));await handle.dispose?.();
 }
}catch(error){process.stderr.write(JSON.stringify({error:error.message,credentialCalls,calls}));process.exitCode=1;}finally{db.close();}
