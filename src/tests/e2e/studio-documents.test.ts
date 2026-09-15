import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
test(
  'offline parser extracts every accepted format, PDF pages and OCR provenance',
  { skip: process.env['AGENTFLOW_STUDIO_TESTS'] !== '1', timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'af-document-formats-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'output'));
    const image =
      process.env['AGENTFLOW_STUDIO_DOCUMENTS_IMAGE'] ??
      'agentflow/studio-documents:issue39';
    await execute('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-v',
      `${root}:/test`,
      '-v',
      `${resolve('src/tests/fixtures/recruitment-documents.py')}:/generate.py:ro`,
      image,
      'python',
      '/generate.py',
    ]);
    await execute('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '-v',
      `${root}/input:/task/input:ro`,
      '-v',
      `${root}/output:/task/outputs`,
      image,
      'python',
      '/opt/agentflow/documents.py',
    ]);
    const result = JSON.parse(
      await readFile(join(root, 'output/result.json'), 'utf8'),
    );
    assert.equal(result.documents.length, 8);
    for (const doc of result.documents)
      assert.match(doc.pages.map((page: any) => page.text).join(' '), /React/);
    assert.equal(result.documents[3].pages.length, 2);
    assert.equal(result.documents[3].pages[1].page, 2);
    assert.equal(result.documents[3].pages[0].method, 'text');
    for (const index of [4, 5, 6, 7]) {
      assert.equal(result.documents[index].pages[0].method, 'ocr');
      assert.match(result.documents[index].notes[0], /OCR/);
    }
  },
);
