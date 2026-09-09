/** Linux-only tool execution view. Paths and programs are deployment-owned. */
export function toolIsolateArguments(temporary, mode, argv) {
    if (!/^\/tmp\/agentflow-tools-[A-Za-z0-9]+$/.test(temporary) || !['read-only', 'workspace-write'].includes(mode) || !argv.length)
        throw new Error('INVALID_TOOL_ISOLATE');
    return ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--ro-bind', '/', '/',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/task/state', '--remount-ro', '/task/state',
        '--bind', temporary, '/tmp', '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp', '--setenv', 'NARB_DISABLE_NATIVE_CACHE', '1',
        ...['/task/input', '/task/work', '/task/outputs'].flatMap(path => [mode === 'workspace-write' ? '--bind' : '--ro-bind', path, path]),
        '--chdir', '/task/work', '--', ...argv];
}
