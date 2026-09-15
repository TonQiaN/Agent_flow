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

test('private Docker interaction sends bounded stdin, disposes once and default tasks keep EOF', async () => {
  const { attach } = await import('./process.js');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'af-docker-interaction-')); const previous = process.env['PATH'];
  try {
    await writeFile(join(root, 'docker'), `#!${process.execPath}\nprocess.stdout.write('ready');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),input})));\n`, { mode: 0o700 });
    process.env['PATH'] = root + ':' + previous;
    let disposed = 0, received = '';
    const interactive = attach('fixture-owned', join(root, 'out'), join(root, 'err'), 4096, {
      open(input) { input.write(Buffer.from('private-fixture-code')); input.end(); return () => { disposed++; }; },
      output(_channel, bytes) { received += Buffer.from(bytes).toString(); },
    });
    await interactive.done;
    assert.equal(interactive.failed, false); assert.equal(interactive.stdout.complete, true); assert.equal(disposed, 1);
    const parsed = JSON.parse(received.slice('ready'.length)); assert.equal(parsed.input, 'private-fixture-code');
    assert.deepEqual(parsed.args, ['start', '--attach', '--interactive', 'fixture-owned']);
    const normal = attach('fixture-normal', join(root, 'normal-out'), join(root, 'normal-err'), 4096); await normal.done;
    const ordinary = JSON.parse((await readFile(join(root, 'normal-out'), 'utf8')).slice('ready'.length));
    assert.equal(ordinary.input, ''); assert.deepEqual(ordinary.args, ['start', '--attach', 'fixture-normal']);
  } finally { if (previous === undefined) delete process.env['PATH']; else process.env['PATH'] = previous; await rm(root, { recursive: true, force: true }); }
});

test('private interaction input overflow and disposal failure invalidate capture without leaking errors', async () => {
  const { attach } = await import('./process.js');
  const root = await mkdtemp(join(tmpdir(), 'af-docker-interaction-errors-')); const previous = process.env['PATH'];
  try {
    await writeFile(join(root, 'docker'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('done'));\n`, { mode: 0o700 });
    process.env['PATH'] = root + ':' + previous;
    for (const mode of ['overflow', 'dispose']) {
      const attached = attach('fixture-owned', join(root, mode + '-out'), join(root, mode + '-err'), 4096, {
        open(input) { if (mode === 'overflow') assert.throws(() => input.write(new Uint8Array(8193)), { message: 'INTERACTION_INPUT_REJECTED' }); input.end(); return () => { if (mode === 'dispose') throw new Error('private-fixture-error'); }; }, output() {},
      });
      await attached.done; assert.equal(attached.failed, true); assert.equal(attached.stdout.complete, false);
      assert.equal(attached.stdout.error, 'ATTACH_TRANSPORT_FAILED'); assert.ok(!JSON.stringify(attached.stdout).includes('private-fixture-error'));
    }
  } finally { if (previous === undefined) delete process.env['PATH']; else process.env['PATH'] = previous; await rm(root, { recursive: true, force: true }); }
});
