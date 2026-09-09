import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@agentflow/domain';
import { deepseekConfiguration, deepseekHeadlessArguments } from './deepseek-configuration.js';

test('DeepSeek configuration rejects unsupported combinations before any execution', () => {
  const valid = { model: 'deepseek-v4-flash', search: false, subagents: false };
  for (const change of [{ model: '-injected' }, { model: 'a b' }, { reasoning: 'medium' }, { reasoning: ['off'] },
    { search: true }, { subagents: true }, { budget: 1 }, { baseURL: 'http://example.com' }, { env: {} }, { argv: [] }]) {
    assert.throws(() => deepseekConfiguration({ ...valid, ...change } as JsonValue), /UNSUPPORTED_DEEPSEEK_CONFIGURATION/);
  }
  for (const raw of [null, [], {}, { model: 'deepseek-v4-flash' }]) assert.throws(() => deepseekConfiguration(raw), /UNSUPPORTED/);
  for (const reasoning of [undefined, 'off', 'low', 'high', 'max']) {
    const result = deepseekConfiguration({ ...valid, ...(reasoning ? { reasoning } : {}) });
    const patches = JSON.parse(result.configFiles[0].content);
    assert.deepEqual(patches.find((p: { id: string }) => p.id === 'agent-default-model').config,
      { provider: 'deepseek-official', model: valid.model });
    assert.equal(patches.find((p: { id: string }) => p.id === 'llm-deepseek').config.reasoningEffort, reasoning);
  }
});

test('DeepSeek headless arguments preserve task text through both option parsers', () => {
  for (const prompt of ['--help', '-x\nquoted "task"', '任务\nline two']) {
    const args = deepseekHeadlessArguments(prompt);
    assert.deepEqual(args.slice(-3), ['--', '--', prompt]);
  }
  for (const prompt of ['', '  ', 'a\0b', 'x'.repeat(65537)]) assert.throws(() => deepseekHeadlessArguments(prompt), /INVALID_HARNESS_PROMPT/);
});
