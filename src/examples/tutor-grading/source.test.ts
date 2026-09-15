import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compileWorkflow, WorkflowRuntime, loadWorkflowCheckpoint } from '@agentflow/engine';
import type { WorkflowNodeExecutor, RunRecord } from '@agentflow/engine';
import { FileArtifactArchive, FileArtifactStore, FileWorkflowCatalog, SqliteRunRecordStore } from '@agentflow/integrations';
import { gradingContracts } from './contracts.js';
import { prepareGradingSource, readGradingSource } from './source.js';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
 const root=await mkdtemp(join(tmpdir(),'af-grading-source-'));
 const source=join(root,'source');await cp(fileURLToPath(new URL('./fixtures/source',import.meta.url)),join(source,'source'),{recursive:true});
 const contracts=gradingContracts(),archive=new FileArtifactArchive(join(root,'archive'),contracts.files),records=await SqliteRunRecordStore.open(join(root,'records'));t.after(async()=>{records.close();await rm(root,{recursive:true,force:true});});
 function composition(name:string){
  const files=new FileWorkflowCatalog(contracts.files,new FileArtifactStore(join(root,name),contracts.files),join(root,'nodes'),archive);
  const executor:WorkflowNodeExecutor={validate(){},contract:files.contract.bind(files),contractDefinition:files.contractDefinition.bind(files),check:files.check.bind(files),
   executionDefinition:async()=>({schema:'source-test/v1'}),checkpointValue:files.checkpointValue.bind(files),restoreValue:files.restoreValue.bind(files),
   execute:async(component,_input,identity)=>({identity,componentId:component.id,status:'failed',code:'TEST_END',stopped:true,issues:[]})};
  const value={kind:'files' as const,id:'source-files'};
  const compiled=compileWorkflow({id:'flow',start:'intake',input:value,outcomes:{done:value},maxSteps:1,nodes:{intake:{component:'intake'}},routes:[{from:'intake',outcome:'ok',to:{end:'done'}}]},
   {resolve:()=>({component:{id:'intake',kind:'transform',implementation:'intake',inputContract:'source-files',outcomes:{ok:'source-files'}},executor})});
  return{files,compiled};
 }
 const app=composition('temporary'),prepared=await prepareGradingSource(app.files,'run',source);
 const run=await new WorkflowRuntime().startPersisted(app.compiled,'run',prepared.input,records);await run.completion;const record=(await records.read('run'))!;await app.files.release(prepared.input,'run');
 return{root,source,archive,records,record,prepared,composition};
}
test('source reopening derives immutable original facts from the actual Run archive without host inputs or writes',async t=>{
 const f=await fixture(t);await rm(f.source,{recursive:true});await rm(join(f.root,'temporary'),{recursive:true});
 const before=await f.records.read('run'),first=await readGradingSource('run',f.records,f.archive);assert.deepEqual(first,f.prepared.source);
 (first.files[0]! as {sha256:string}).sha256='0'.repeat(64);assert.deepEqual(await readGradingSource('run',f.records,f.archive),f.prepared.source);assert.deepEqual(await f.records.read('run'),before);
 const app=f.composition('fresh'),loaded=await loadWorkflowCheckpoint(app.compiled,'run',f.records);await loaded.dispose();
 const wrapper:RunRecord={runId:'run',revision:2,content:{schema:'agentflow-workflow-recovery/v1',checkpoint:f.record.content,claimRevision:2,resourceRemoved:true}};
 assert.deepEqual(await readGradingSource('run',{read:async()=>wrapper},f.archive),f.prepared.source);
});
test('source metadata rejects foreign, malformed, noninitial and altered records before archive access',async t=>{
 const f=await fixture(t);let reads=0;const archive={read:async()=>{reads++;throw new Error('unexpected');}};
 const mutations:((r:any)=>void)[]=[r=>r.runId='foreign',r=>r.revision=0,r=>r.content.schema='agentflow-workflow-checkpoint/v4',r=>r.content.snapshot.runId='foreign',
  r=>r.content.values[0].node='other',r=>r.content.values[0].contract.id='candidate-files',r=>r.content.values[0].saved.runId='foreign',r=>r.content.values[0].saved.receipt={},
  r=>r.content.values[0].saved.value.fileRef='forged',r=>r.content.values[0].saved.archive.sha256='invalid',r=>r.content.values[0].saved.manifest.id='invalid',
  r=>r.content={schema:'agentflow-workflow-recovery/v1',checkpoint:r.content,claimRevision:r.revision+1,resourceRemoved:true}];
 for(const mutate of mutations){const row=structuredClone(f.record);mutate(row);await assert.rejects(readGradingSource('run',{read:async()=>row},archive));}
 await assert.rejects(readGradingSource('run',{read:async()=>null},archive),/GRADING_RUN_NOT_FOUND/);assert.equal(reads,0);
});
test('source metadata is bound to the archive manifest, not a caller-provided hash list',async t=>{
 const f=await fixture(t),row=structuredClone(f.record),c=row.content as any;c.values[0].saved.manifest.files[0].sha256='f'.repeat(64);
 await assert.rejects(readGradingSource('run',{read:async()=>row},f.archive),/GRADING_SOURCE_ARCHIVE_MISMATCH/);
 const reference=(f.record.content as any).values[0].saved.archive;
 const manifest=await f.archive.read(reference);await assert.rejects(readGradingSource('run',f.records,{read:async()=>({...manifest,id:'not-the-requested-archive'})}),/GRADING_SOURCE_ARCHIVE_MISMATCH/);
});
test('metadata bootstrap cannot hide corrupted bytes from subsequent full checkpoint restoration',async t=>{
 const f=await fixture(t),reference=(f.record.content as any).values[0].saved.archive;
 await writeFile(join(f.root,'archive',reference.id,'data/source/key.json'),'{"q1":999}');
 assert.deepEqual(await readGradingSource('run',f.records,f.archive),f.prepared.source);
 const app=f.composition('fresh');await assert.rejects(loadWorkflowCheckpoint(app.compiled,'run',f.records));
 assert.deepEqual(await f.records.read('run'),f.record);
});
