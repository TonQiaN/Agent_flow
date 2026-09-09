import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docker } from './process.js';

test('Docker credential transport overrides ambient values without putting secrets in argv and sanitizes failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-docker-env-'));
  const originalPath = process.env['PATH'], originalKey = process.env['DEEPSEEK_API_KEY'];
  try {
    await writeFile(join(root, 'docker'), `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes('fail')){process.stderr.write(process.env.DEEPSEEK_API_KEY);process.exit(1);} process.stdout.write(JSON.stringify({args,key:process.env.DEEPSEEK_API_KEY}));\n`, { mode: 0o700 });
    process.env['PATH'] = root + ':' + originalPath; process.env['DEEPSEEK_API_KEY'] = 'fixture-ambient-wrong';
    const args = ['create', '--env', 'DEEPSEEK_API_KEY', 'fixture-image'];
    const returned = JSON.parse(await docker(args, 5000, { DEEPSEEK_API_KEY: 'fixture-selected-key' }));
    assert.deepEqual(returned.args, args); assert.equal(returned.key, 'fixture-selected-key');
    assert.ok(!returned.args.join(' ').includes('fixture-selected-key'));
    assert.equal(process.env['DEEPSEEK_API_KEY'], 'fixture-ambient-wrong');
    await assert.rejects(docker(['create', 'fail'], 5000, { DEEPSEEK_API_KEY: 'fixture-selected-key' }), { message: 'DOCKER_COMMAND_FAILED' });
    await assert.rejects(docker(['inspect'], 5000, { DEEPSEEK_API_KEY: 'fixture-selected-key' }), { message: 'INVALID_CREDENTIAL_COMMAND' });
    await assert.rejects(docker(args, 5000, { NODE_OPTIONS: 'fixture-selected-key' }), { message: 'INVALID_CREDENTIAL_ENVIRONMENT' });
  } finally {
    if (originalPath === undefined) delete process.env['PATH']; else process.env['PATH'] = originalPath;
    if (originalKey === undefined) delete process.env['DEEPSEEK_API_KEY']; else process.env['DEEPSEEK_API_KEY'] = originalKey;
    await rm(root, { recursive: true, force: true });
  }
});
