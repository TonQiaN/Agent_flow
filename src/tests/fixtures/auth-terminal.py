"""Real POSIX PTY acceptance. Inputs are fixed synthetic values; print only non-secret checks."""
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time

node, cli, store, mode = sys.argv[1:]
master, slave = os.openpty()
before = termios.tcgetattr(slave)
args = [node, cli, 'auth', 'configure', 'deepseek', '--store', store, '--credential-ref', 'terminal']
if mode == 'timeout':
    module = os.path.join(os.path.dirname(cli), 'hidden-input.js')
    script = "import {readHiddenInput} from " + json.dumps(module) + "; try {await readHiddenInput(process.stdin,process.stderr,300);} catch(e){process.stderr.write(e.message);process.exitCode=1;}"
    args = [node, '--input-type=module', '-e', script]
child = subprocess.Popen(args, stdin=slave, stdout=subprocess.PIPE, stderr=slave, start_new_session=True)
observed = bytearray()
try:
    deadline = time.monotonic() + 10
    while b'(hidden): ' not in observed:
        if time.monotonic() >= deadline:
            raise RuntimeError('TERMINAL_PROMPT_TIMEOUT')
        if select.select([master], [], [], 0.1)[0]:
            observed.extend(os.read(master, 16384))
        if child.poll() is not None:
            raise RuntimeError('TERMINAL_EXITED_BEFORE_PROMPT')
    hidden_during_prompt = not bool(termios.tcgetattr(slave)[3] & termios.ECHO)
    values = {
        'success': b'fixture-terminal-key\r',
        'edit': b'fixture-wrong\x15fixture-terminal-kez\x7fy\r',
        'cancel': b'fixture-terminal-key\x03',
        'eof': b'fixture-terminal-key\x04',
        'invalid': b'fixture bad key\r',
        'oversized': b'x' * 8193 + b'\r',
        'short': b'short\r',
    }
    if mode in values:
        remaining = values[mode]
        while remaining:
            n = os.write(master, remaining)
            remaining = remaining[n:]
    elif mode == 'signal':
        os.write(master, b'fixture-terminal-key')
        child.send_signal(signal.SIGTERM)
    elif mode != 'timeout':
        raise RuntimeError('UNKNOWN_TERMINAL_TEST')
    stdout, _ = child.communicate(timeout=10)
    while select.select([master], [], [], 0.05)[0]:
        observed.extend(os.read(master, 16384))
    restored = termios.tcgetattr(slave) == before
    # The synthetic typed value and submitted value must not be echoed or appear in public status.
    leaked = b'fixture-terminal-key' in observed or b'fixture-terminal-key' in stdout or b'fixture-wrong' in observed
    data = {'exit': child.returncode, 'hidden': hidden_during_prompt, 'restored': restored, 'leaked': leaked}
    if stdout:
        data['status'] = json.loads(stdout)
    for code in ['AUTH_INPUT_CANCELLED', 'AUTH_INPUT_INVALID', 'AUTH_INPUT_TIMEOUT', 'INVALID_CREDENTIAL_CONTENT']:
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
