#!/usr/bin/env python3
"""Bounded startup, readiness and signal tests using disposable subprocesses."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

ENTRYPOINT = Path(__file__).resolve().parents[1] / 'docker/entrypoint.sh'


class EntrypointReadiness(unittest.TestCase):
    def scenario(self, *, publish='0', migration='0', ping='0', wasm=True, expected='ready', shutdown_during=None):
        with tempfile.TemporaryDirectory(prefix='selfbase-readiness-') as directory:
            root = Path(directory)
            ready = root / 'ready'
            ready.write_text('ready\n')  # A prior process must not confer readiness.
            credentials = root / 'cli.toml'
            credentials.write_text('fake-persistent-owner')
            module = root / 'module.wasm'
            if wasm:
                module.touch()
            mock = root / 'spacetime'
            mock.write_text('''#!/bin/sh
printf '%s %s\\n' "$1" "$$" >> "$COMMAND_LOG"
case "$1" in
 start) exec sleep 300 ;;
 publish) if [ "$PUBLISH" = hang ]; then exec sleep 300; fi; exit "$PUBLISH" ;;
 call) if [ "$MIGRATION" = hang ]; then exec sleep 300; fi; exit "$MIGRATION" ;;
esac
''')
            mock.chmod(0o755)
            wget = root / 'wget'
            wget.write_text('#!/bin/sh\nexit "$PING"\n')
            wget.chmod(0o755)
            commands = root / 'commands'
            env = dict(os.environ, PATH=f'{root}:' + os.environ['PATH'],
                STDB_DATA_DIR=str(root / 'data'), MODULE_WASM=str(module), STDB_READY_FILE=str(ready),
                COMMAND_LOG=str(commands), PUBLISH=publish, MIGRATION=migration, PING=ping,
                STDB_STARTUP_TIMEOUT='1', STDB_PUBLISH_TIMEOUT='1', STDB_MIGRATION_TIMEOUT='1')
            with (root / 'output').open('w+') as output:
                process = subprocess.Popen(['sh', str(ENTRYPOINT)], env=env, stdout=output, stderr=output, start_new_session=True)
                try:
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline:
                        state = ready.read_text().strip()
                        logged = commands.read_text() if commands.exists() else ''
                        if shutdown_during and shutdown_during in logged:
                            process.terminate()
                            process.wait(timeout=4)
                            break
                        if not shutdown_during and state == expected and (expected != 'ready' or 'call ' in logged):
                            break
                        if expected == 'stopped' and process.poll() is not None:
                            break
                        self.assertIsNone(process.poll(), output.read())
                        time.sleep(.02)
                    else:
                        output.seek(0)
                        self.fail('Entrypoint did not reach expected state: ' + output.read())
                    self.assertEqual(credentials.read_text(), 'fake-persistent-owner')
                    if expected == 'stopped' or shutdown_during:
                        process.wait(timeout=4)
                    else:
                        self.assertIsNone(process.poll(), 'Existing database server should remain available')
                        self.assertEqual(ready.read_text().strip(), expected)
                        if expected in ('publish-failed', 'module-missing'):
                            self.assertNotIn('call ', commands.read_text())
                        process.terminate()
                        process.wait(timeout=4)
                    self.assertEqual(ready.read_text().strip(), 'stopped')
                    for line in commands.read_text().splitlines():
                        pid = int(line.split()[1])
                        # Reaped children must not remain running after PID 1 exits.
                        stat = Path(f'/proc/{pid}/stat')
                        if stat.exists():
                            self.assertEqual(stat.read_text().split()[2], 'Z', f'Leaked child {pid}')
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    if commands.exists():
                        for line in commands.read_text().splitlines():
                            try:
                                os.kill(int(line.split()[1]), signal.SIGKILL)
                            except ProcessLookupError:
                                pass

    def test_success(self): self.scenario()
    def test_publish_failure(self): self.scenario(publish='1', expected='publish-failed')
    def test_migration_failure(self): self.scenario(migration='1', expected='migration-failed')
    def test_missing_module(self): self.scenario(wasm=False, expected='module-missing')
    def test_startup_timeout(self): self.scenario(ping='1', expected='stopped')
    def test_publish_timeout(self): self.scenario(publish='hang', expected='publish-failed')
    def test_migration_timeout(self): self.scenario(migration='hang', expected='migration-failed')
    def test_signal_during_migration(self): self.scenario(migration='hang', shutdown_during='call ')


if __name__ == '__main__': unittest.main()
