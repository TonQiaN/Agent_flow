import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedUserNamespacePolicy } from './sandbox-policy.js';

test('nested sandbox policy keeps default denial and excludes unrelated privileged kernel APIs', () => {
  const policy = JSON.parse(nestedUserNamespacePolicy()) as { defaultAction: string; syscalls: { names: string[]; action: string; includes?: unknown; args?: unknown }[] };
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ['add_key', 'keyctl', 'io_uring_setup', 'kexec_load', 'userfaultfd']) {
    assert.ok(!policy.syscalls.some(rule => rule.names.includes(name) && rule.action === 'SCMP_ACT_ALLOW'), name);
  }
  for (const name of ['bpf', 'open_by_handle_at', 'init_module', 'reboot']) {
    assert.ok(!policy.syscalls.some(rule => rule.names.includes(name) && rule.action === 'SCMP_ACT_ALLOW' && !rule.includes && !rule.args), name);
  }
  assert.ok(!policy.syscalls.some(rule => rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO'));
});
