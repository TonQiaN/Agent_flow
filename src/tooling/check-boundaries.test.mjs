import test from 'node:test';
import assert from 'node:assert/strict';
import { importSpecifiers, importViolation, checkBoundaries } from './check-boundaries.mjs';

test('finds imports, exports, type imports and rejects computed loading', () => {
  assert.deepEqual(importSpecifiers(`import type { X } from 'a'; export { y } from 'b';
    type Z = import('c').Z; import('d'); require('e'); import(variable);`, 'sample.ts'), ['a', 'b', 'c', 'd', 'e', null]);
});

test('rejects layer reversal, private subpaths, cross-package relatives and undeclared dependencies', () => {
  const engine = { name: '@agentflow/engine', directory: '/repo/src/packages/engine', app: false,
    dependencies: { '@agentflow/domain': '0', '@agentflow/integrations': '0', '@agentflow/cli': '0', ajv: '8' } };
  const domain = { name: '@agentflow/domain', directory: '/repo/src/packages/domain', app: false, dependencies: {} };
  const integrations = { name: '@agentflow/integrations', app: false };
  const cli = { name: '@agentflow/cli', app: true };
  const packages = [engine, domain, integrations, cli];
  const check = specifier => importViolation(engine, '/repo/src/packages/engine/components/index.ts', specifier, packages);
  for (const specifier of ['node:fs', 'fs/promises', '../../domain/index.js', '@agentflow/domain/dist/index.js',
    '@agentflow/integrations', '@agentflow/cli', 'unlisted', '/tmp/module.js', 'file:///tmp/module.js', null]) assert.ok(check(specifier), String(specifier));
  for (const specifier of ['../contracts/index.js', '@agentflow/domain', 'ajv/dist/2020.js']) assert.equal(check(specifier), undefined);
  assert.ok(importViolation(domain, '/repo/src/packages/domain/index.ts', 'node:crypto', packages));
});

test('actual production tree satisfies the dependency rules', () => assert.deepEqual(checkBoundaries(), []));

test('tracks createRequire aliases and still rejects undeclared or computed runtime imports', () => {
  assert.deepEqual(importSpecifiers(`import { createRequire as create } from 'node:module';
    const loadSdk = create('/image/package.json'); loadSdk('sdk'); loadSdk(name); import(loadSdk.resolve('sdk/subpath')); import(loadSdk.resolve(name));`, 'runtime.mjs'), ['node:module', 'sdk', null, 'sdk/subpath', null]);
  const runtime = { name: '@agentflow/runtime', directory: '/repo/src/apps/runtime', app: true, dependencies: { sdk: '1' } };
  assert.equal(importViolation(runtime, runtime.directory + '/main.mjs', 'sdk', [runtime]), undefined);
  assert.ok(importViolation(runtime, runtime.directory + '/main.mjs', 'missing', [runtime]));
  assert.ok(importViolation(runtime, runtime.directory + '/main.mjs', null, [runtime]));
});
