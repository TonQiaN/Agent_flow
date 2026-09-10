import test from 'node:test';
import assert from 'node:assert/strict';
import { gradingFileScripts, gradingSourceFacts } from './file-scripts.js';
import { sourcePaths } from './gate.js';
test('grading scripts capture canonical source hashes as argv data and actual installed scorer code',async()=>{
 const facts={files:[...sourcePaths].reverse().map(path=>({path,sha256:'a'.repeat(64)}))};
 const pending=gradingFileScripts(facts);facts.files[0]!.sha256='b'.repeat(64);const scripts=await pending;
 assert.deepEqual(scripts.source.files.map(f=>f.path),sourcePaths);assert.ok(scripts.source.files.every(f=>f.sha256==='a'.repeat(64)));
 assert.deepEqual(scripts.gate.argv.slice(0,3),['node','--input-type=module','-e']);assert.deepEqual(JSON.parse(scripts.gate.argv[4]!),scripts.source);
 assert.match(scripts.gate.argv[3]!,/SOURCE_CHANGED/);assert.match(scripts.gate.argv[3]!,/process.argv\[1\]/);assert.doesNotMatch(scripts.gate.argv[3]!,/import type|interface Candidate|@agentflow/);
 (scripts.source.files[0]! as {sha256:string}).sha256='c'.repeat(64);
 assert.equal(scripts.gate.argv[4]!.includes('b'.repeat(64)),false);assert.equal(scripts.gate.argv[4]!.includes('c'.repeat(64)),false);
});
test('grading scripts reject incomplete, duplicate and malformed original-source evidence',async()=>{
 const valid=sourcePaths.map(path=>({path,sha256:'a'.repeat(64)}));
 for(const files of [[],valid.slice(1),[valid[0]!,valid[0]!,valid[2]!],valid.map(f=>({...f,sha256:'not-a-hash'})),[...valid,{path:'candidate.json',sha256:'a'.repeat(64)}]]){
  assert.throws(()=>gradingSourceFacts({files}),/INVALID_GRADING_SOURCE_FACTS/);await assert.rejects(gradingFileScripts({files}),/INVALID_GRADING_SOURCE_FACTS/);
 }
});
test('durable grading publication target is captured as a separate argument',async()=>{
 const facts={files:sourcePaths.map(path=>({path,sha256:'a'.repeat(64)}))},publication={workoutId:'fixture-workout'};
 const pending=gradingFileScripts(facts,publication);publication.workoutId='other-workout';const scripts=await pending;
 assert.equal(JSON.parse(scripts.gate.argv[5]!),'fixture-workout');assert.match(scripts.gate.argv[3]!,/publicationInput/);
 assert.match(scripts.gate.argv[3]!,/result.outcome === 'passed'/);assert.match(scripts.gate.argv[3]!,/process.argv\[2\]/);
 await assert.rejects(gradingFileScripts(facts,{workoutId:'../invalid'}),/INVALID_GRADING_PUBLICATION/);
});
