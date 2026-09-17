import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { posix } from 'node:path';
import type { HarnessPlan } from '@agentflow/engine';
import { codexInvocation } from './codex-session.js';

test('Codex session envelope bounds encoded UTF-8 bytes and keeps a readable truncation record', () => {
  const plan = { argv: ['codex', 'exec'], configFiles: [] } as unknown as HarnessPlan;
  const invocation = codexInvocation(plan), child = new EventEmitter();
  const content = JSON.stringify({ text: '\\'.repeat(5 * 1024 * 1024) }) + '\n';
  let archive = '';
  const fs = { existsSync: () => true, readdirSync: () => [{ name: 'session.jsonl', isDirectory: () => false, isFile: () => true }],
    statSync: () => ({ size: Buffer.byteLength(content) }), readFileSync: (path: string) => path.endsWith('argv.json') ? '[]' : content,
    writeFileSync: (_: string, value: string) => { archive = value; } };
  runInNewContext(invocation.configFiles!.find(f => f.name === 'codex-session.cjs')!.content,
    { require: (id: string) => id === 'node:fs' ? fs : id === 'node:path' ? posix : { spawn: () => child }, process: {}, Buffer });
  child.emit('close', 0);
  assert.ok(Buffer.byteLength(archive) <= invocation.recordFiles![0]!.maxBytes);
  const parsed = JSON.parse(archive);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.records, []);
});
