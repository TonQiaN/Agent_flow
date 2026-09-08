import base from './policies/moby-seccomp.json' with { type: 'json' };

// Required by nested unprivileged bubblewrap. Outer container capabilities remain empty.
const namespaceCalls = new Set(['clone', 'clone3', 'unshare', 'setns', 'mount', 'umount', 'umount2', 'pivot_root',
  'fsconfig', 'fsmount', 'fsopen', 'fspick', 'mount_setattr', 'move_mount', 'open_tree']);

export function nestedUserNamespacePolicy(): string {
  // Preserve the vendored baseline. In particular, don't add a broad default ALLOW rule.
  const syscalls = base.syscalls.map(rule => ({ ...rule, names: rule.names.filter(name => !namespaceCalls.has(name)) }))
    .filter(rule => rule.names.length !== 0);
  // Remove conditional/errno entries for these names before adding the explicit allowance;
  // otherwise clone3's ENOSYS rule wins over ALLOW in seccomp's action precedence.
  return JSON.stringify({ ...base, syscalls: [...syscalls, { names: [...namespaceCalls].sort(), action: 'SCMP_ACT_ALLOW' }] });
}
