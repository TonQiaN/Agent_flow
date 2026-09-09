import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileCredentialStore, DeepSeekApiKeyCodec } from '@agentflow/integrations';
const cli = resolve('src/apps/cli/dist/index.js');
const identity = { credentialRef: 'fixture', service: 'deepseek', method: 'api-key' };
const record = JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-explicit-key' });
const invoke = (args: string[], input?: string) => spawnSync(process.execPath, [cli, 'auth', ...args], {
  encoding: 'utf8', timeout: 5000, ...(input === undefined ? {} : { input }), env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-ambient-wrong' },
});

test('compiled auth CLI imports one explicit file, reports only local state and deletes locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-auth-cli-'));
  try {
    const store = join(root, 'store'), source = join(root, 'source'); await writeFile(source, record, { mode: 0o600 });
    const args = ['deepseek', '--store', store, '--credential-ref', 'fixture'];
    const imported = invoke(['configure', ...args, '--file', source]); assert.equal(imported.status, 0, imported.stderr);
    const status = JSON.parse(imported.stdout); assert.equal(status.remoteStatus, 'unknown'); assert.equal(status.revision, 1);
    assert.ok(!JSON.stringify(imported).includes('fixture-explicit-key')); assert.ok(!imported.stdout.includes('fixture-ambient-wrong'));
    const reader = new FileCredentialStore(store, [new DeepSeekApiKeyCodec()]), lease = await reader.acquire(identity);
    try {
      assert.equal(await lease.readSecret(), record);
      const busy = invoke(['delete', ...args]); assert.equal(busy.status, 1); assert.equal(busy.stderr, 'CREDENTIAL_BUSY\n');
    } finally { await lease.release(); }
    assert.deepEqual(JSON.parse(invoke(['inspect', ...args]).stdout), status);
    const deleted = invoke(['delete', ...args]); assert.equal(deleted.status, 0); assert.deepEqual(JSON.parse(deleted.stdout), { deleted: true, remoteRevoked: false });
    assert.equal(invoke(['inspect', ...args]).stdout, 'null\n'); assert.equal(await readFile(source, 'utf8'), record);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('auth CLI refuses pipes, secret arguments, duplicate sources, unsupported providers and unsafe files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-auth-reject-'));
  try {
    const store = join(root, 'store'), source = join(root, 'source'); await writeFile(source, record, { mode: 0o644 });
    const args = ['deepseek', '--store', store, '--credential-ref', 'fixture'];
    const piped = invoke(['configure', ...args], 'fixture-piped-key\n'); assert.equal(piped.status, 1); assert.equal(piped.stderr, 'AUTH_INPUT_REQUIRES_TERMINAL\n');
    for (const command of [ ['configure', ...args, '--key', 'fixture-argv-key'], ['configure', ...args, '--file', source, '--file', source],
      ['configure', ...args, '--store', store], ['inspect', ...args, '--file', source], ['login', ...args], ['configure', 'claude', '--store', store, '--credential-ref', 'fixture'] ]) {
      const bad = invoke(command); assert.equal(bad.status, 2); assert.equal(bad.stdout, ''); assert.ok(!bad.stderr.includes('fixture-argv-key'));
    }
    assert.equal(invoke(['configure', ...args, '--file', source]).stderr, 'UNSAFE_CREDENTIAL_FILE\n');
    await chmod(source, 0o600); const alias = join(root, 'alias'); await symlink(source, alias);
    assert.equal(invoke(['configure', ...args, '--file', alias]).stderr, 'UNSAFE_CREDENTIAL_FILE\n');
    await writeFile(source, '{"schema":"wrong","api_key":"fixture-private-value"}');
    assert.equal(invoke(['configure', ...args, '--file', source]).stderr, 'INVALID_CREDENTIAL_CONTENT\n');
    assert.equal(invoke(['inspect', ...args]).stdout, 'null\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['success', 'edit', 'cancel', 'eof', 'signal', 'invalid', 'oversized', 'short', 'timeout']) test(`real terminal auth ${mode}: hidden input, terminal restoration and exact storage`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-auth-tty-'));
  try {
    const store = join(root, 'store');
    const processResult = spawnSync('python3', ['src/tests/fixtures/auth-terminal.py', process.execPath, cli, store, mode], { encoding: 'utf8', timeout: 15000 });
    assert.equal(processResult.status, 0, processResult.stderr);
    const result = JSON.parse(processResult.stdout); assert.equal(result.hidden, true); assert.equal(result.restored, true); assert.equal(result.leaked, false);
    const configured = new FileCredentialStore(store, [new DeepSeekApiKeyCodec()]);
    if (mode === 'success' || mode === 'edit') {
      assert.equal(result.exit, 0); assert.equal(result.status.remoteStatus, 'unknown');
      const lease = await configured.acquire({ ...identity, credentialRef: 'terminal' });
      try { assert.equal(JSON.parse(await lease.readSecret()).api_key, 'fixture-terminal-key'); } finally { await lease.release(); }
    } else {
      assert.equal(result.exit, 1); assert.equal(await configured.inspect({ ...identity, credentialRef: 'terminal' }), null);
      assert.equal(result.diagnostic, ['cancel', 'eof', 'signal'].includes(mode) ? 'AUTH_INPUT_CANCELLED' : mode === 'timeout' ? 'AUTH_INPUT_TIMEOUT' : mode === 'short' ? 'INVALID_CREDENTIAL_CONTENT' : 'AUTH_INPUT_INVALID');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
