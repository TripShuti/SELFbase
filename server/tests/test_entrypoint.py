"""Exercise entrypoint subprocess behavior without touching a real database."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

ENTRYPOINT = Path(__file__).resolve().parents[1] / 'docker/entrypoint.sh'


class EntrypointTest(unittest.TestCase):
    def scenario(self, publish_status, migration_status):
        with tempfile.TemporaryDirectory(prefix='selfbase-entrypoint-') as tmp:
            tmp = Path(tmp)
            credentials = tmp / '.config/spacetime/cli.toml'
            credentials.parent.mkdir(parents=True)
            credentials.write_text('private-key-sentinel')
            wasm = tmp / 'server.wasm'
            wasm.touch()
            commands = tmp / 'commands'
            mock = tmp / 'spacetime'
            mock.write_text('''#!/bin/sh
printf '%s\\n' "$1" >> "$COMMAND_LOG"
case "$1" in
 start) exec sleep 300 ;;
 publish) exit "$PUBLISH_STATUS" ;;
 call) exit "$MIGRATION_STATUS" ;;
esac
''')
            mock.chmod(0o755)
            wget = tmp / 'wget'
            wget.write_text('#!/bin/sh\nexit 0\n')
            wget.chmod(0o755)
            env = dict(os.environ, XDG_CONFIG_HOME=str(tmp / ".config"), STDB_READY_FILE=str(tmp / "ready"), PATH=f'{tmp}:' + os.environ['PATH'],
                       STDB_DATA_DIR=str(tmp / 'data'), MODULE_WASM=str(wasm),
                       COMMAND_LOG=str(commands), PUBLISH_STATUS=str(publish_status),
                       MIGRATION_STATUS=str(migration_status))
            with (tmp / 'output').open('w+') as output:
                process = subprocess.Popen(['sh', str(ENTRYPOINT)], env=env,
                                           stdout=output, stderr=output, start_new_session=True)
                try:
                    for _ in range(100):
                        output.seek(0)
                        text = output.read()
                        if ('post-publish migrations are skipped' in text or
                            'Pending migrations complete.' in text or
                            'run_pending_migrations failed.' in text):
                            break
                        self.assertIsNone(process.poll(), text)
                        time.sleep(0.02)
                    else:
                        self.fail('Entrypoint did not reach server wait')
                    self.assertIsNone(process.poll(), 'Publish/migration failure stopped server')
                    calls = commands.read_text().splitlines()
                    self.assertEqual(calls.count('publish'), 1)
                    self.assertEqual(calls.count('call'), int(publish_status == 0))
                    self.assertEqual(credentials.read_text(), 'private-key-sentinel')
                    # Signal only PID 1: entrypoint must forward termination to the server.
                    process.terminate()
                    process.wait(timeout=3)
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()

    def test_publish_failure_keeps_server_running_and_skips_migrations(self):
        self.scenario(1, 0)

    def test_success_runs_migrations(self):
        self.scenario(0, 0)

    def test_migration_failure_keeps_server_running(self):
        self.scenario(0, 1)

    def test_never_removes_cli_configuration(self):
        text = ENTRYPOINT.read_text()
        self.assertNotIn('rm ', text)
        self.assertNotIn('/root/.config/spacetime', text)


if __name__ == '__main__':
    unittest.main()
