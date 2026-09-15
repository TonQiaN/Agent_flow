"""Compiled login CLI through a real POSIX PTY; fixed synthetic inputs only."""
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time

node, cli, store, workspace, image, provider, mode = sys.argv[1:]
master, slave = os.openpty()
before = termios.tcgetattr(slave)
args = [node, cli, 'auth', 'login', provider, '--store', store, '--credential-ref', 'terminal',
        '--workspace', workspace, '--image', image, '--proxy-image', 'node:22-bookworm-slim',
        '--timeout-ms', '4000' if mode == 'timeout' else '20000']
child = subprocess.Popen(args, stdin=slave, stdout=subprocess.PIPE, stderr=slave, start_new_session=True)
observed = bytearray()
try:
    deadline = time.monotonic() + 30
    marker = b'Preparing subscription login' if mode in ['early-signal', 'timeout'] else b'fixture-authorization-ready'
    while marker not in observed:
        if time.monotonic() >= deadline:
            raise RuntimeError('LOGIN_TERMINAL_PROMPT_TIMEOUT')
        if select.select([master], [], [], 0.1)[0]:
            observed.extend(os.read(master, 16384))
        if child.poll() is not None:
            raise RuntimeError('LOGIN_TERMINAL_EXITED_BEFORE_PROMPT')
    hidden = not bool(termios.tcgetattr(slave)[3] & termios.ECHO)
    values = {
        'success': b'fixture-auth-code\r',
        'cleanup-pending': b'fixture-auth-code\r',
        'edit': b'fixture-wrong\x15fixture-auth-codz\x7fe\r',
        'cancel': b'fixture-auth-code\x03',
        'eof': b'fixture-auth-code\x04',
        'invalid': b'fixture code\r',
        'oversized': b'x' * 8192 + b'\r',
        'multiline': b'fixture-auth-code\nfixture-extra\n',
    }
    if mode in values:
        rest = values[mode]
        while rest:
            n = os.write(master, rest)
            rest = rest[n:]
    elif mode in ['signal', 'early-signal']:
        if mode == 'signal':
            os.write(master, b'fixture-auth-code')
        child.send_signal(signal.SIGTERM)
    elif mode != 'timeout':
        raise RuntimeError('UNKNOWN_LOGIN_TERMINAL_TEST')
    # Drain both PTY and public pipe while the child restores terminal mode. On macOS,
    # tcsetattr drain can wait for unread PTY output even when the login itself is done.
    public = bytearray()
    public_open = True
    deadline = time.monotonic() + 35
    while child.poll() is None or public_open:
        if time.monotonic() >= deadline:
            raise RuntimeError('LOGIN_TERMINAL_COMPLETION_TIMEOUT')
        streams = [master] + ([child.stdout] if public_open else [])
        ready = select.select(streams, [], [], 0.1)[0]
        if master in ready:
            observed.extend(os.read(master, 16384))
        if public_open and child.stdout in ready:
            chunk = os.read(child.stdout.fileno(), 16384)
            if chunk:
                public.extend(chunk)
            else:
                public_open = False
    stdout = bytes(public)
    while select.select([master], [], [], 0.05)[0]:
        observed.extend(os.read(master, 16384))
    leaked = any(x in observed or x in stdout for x in [b'fixture-auth-code', b'fixture-wrong', b'fixture-extra'])
    data = {'exit': child.returncode, 'hidden': hidden, 'restored': termios.tcgetattr(slave) == before, 'leaked': leaked,
            'controls': b'\x1b' in observed or b'\x07' in observed}
    if stdout:
        data['status'] = json.loads(stdout)
    for code in ['AUTH_LOGIN_CANCELLED', 'AUTH_LOGIN_TIMEOUT', 'AUTH_LOGIN_INPUT_INVALID', 'AUTH_LOGIN_CLEANUP_PENDING']:
        if code.encode() in observed:
            data['diagnostic'] = code
    print(json.dumps(data))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    termios.tcsetattr(slave, termios.TCSANOW, before)
    os.close(master)
    os.close(slave)
