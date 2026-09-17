import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUpload } from './upload.js';

test('grading rejects disguised or malformed JSON before creating a run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-grading-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const form = (name: string, bytes: string) => {
    const body = new FormData();
    body.set('manifest', JSON.stringify({ workflowId: 'grading-real', title: 'test', documents: ['paper', 'key', 'submission'].map(n => ({ path: `source/${n}.json` })) }));
    for (let i = 0; i < 3; i++) body.set(`file-${i}`, new File([i ? '{}' : bytes], i ? `input-${i}.json` : name));
    return body;
  };
  const workflow = { id: 'grading-real', input: 'grading' };
  await assert.rejects(prepareUpload(form('paper.pdf', '%PDF-1.7'), root, workflow, false), /JSON/);
  await assert.rejects(prepareUpload(form('paper.txt', '{}'), root, workflow, false), /JSON/);
  await assert.rejects(prepareUpload(form('paper.json', '{broken'), root, workflow, false), /JSON/);
  const result = await prepareUpload(form('paper.json', '{}'), root, workflow, false);
  assert.equal(result.uploads.length, 3);
  assert.ok(result.uploads.every(f => f.mediaType === 'application/json'));
});
