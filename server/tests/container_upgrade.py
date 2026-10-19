#!/usr/bin/env python3
"""Real pinned-image lifecycle test; only disposable containers/host directories."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'clockworklabs/spacetime:v2.0.3'


def main():
    # Exercise the configured health command, including YAML/shell quoting.
    config = json.loads(subprocess.check_output(['docker', 'compose', 'config', '--format', 'json'], cwd=ROOT))
    health_command = config['services']['spacetimedb']['healthcheck']['test'][1].replace('$$', '$')
    assert config['services']['web']['depends_on']['spacetimedb']['condition'] == 'service_healthy'
    with tempfile.TemporaryDirectory(prefix='selfbase-container-upgrade-') as directory:
        state = Path(directory)
        module = state / 'module.wasm'
        module.write_bytes(subprocess.check_output(['git', 'show', '4cd90eb:server/docker/server.wasm'], cwd=ROOT))
        cid = subprocess.check_output(['docker', 'run', '-d', '--network', 'none', '--user', 'root',
            '-e', 'STDB_DATA_DIR=/test-state/data', '-e', 'XDG_CONFIG_HOME=/test-state/config',
            '-e', 'STDB_STARTUP_TIMEOUT=30', '-e', 'STDB_PUBLISH_TIMEOUT=60', '-e', 'STDB_MIGRATION_TIMEOUT=60',
            '-v', str(state) + ':/test-state', '-v', str(module) + ':/module/server.wasm:ro',
            '-v', str(ROOT / 'server/docker/entrypoint.sh') + ':/entrypoint.sh:ro',
            '--health-cmd', health_command, '--health-interval', '1s', '--health-retries', '1',
            '--entrypoint', '/bin/sh', IMAGE, '/entrypoint.sh'], text=True).strip()
        try:
            def execute(*args, check=True):
                result = subprocess.run(['docker', 'exec', cid, *args], text=True, capture_output=True, timeout=30)
                if check: assert result.returncode == 0, result.stderr
                return result

            def wait_ready(expected='ready'):
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    status = execute('cat', '/tmp/selfbase-ready', check=False).stdout.strip()
                    if status == expected:
                        health = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Health.Status}}', cid], text=True).strip()
                        if health == ('healthy' if expected == 'ready' else 'unhealthy'): return
                    if status in ('publish-failed', 'migration-failed') and expected == 'ready':
                        raise AssertionError('Unexpected startup state: ' + status)
                    time.sleep(.25)
                raise AssertionError('Container did not reach ' + expected)

            def sql(query):
                return '\n'.join(sorted(execute('spacetime', 'sql', '--server', 'http://localhost:3000', 'selfbase', query).stdout.splitlines()))

            def restart():
                subprocess.run(['docker', 'stop', '--time', '8', cid], check=True, stdout=subprocess.DEVNULL)
                subprocess.run(['docker', 'start', cid], check=True, stdout=subprocess.DEVNULL)

            wait_ready()
            execute('spacetime', 'call', '--server', 'http://localhost:3000', '--no-config', '--yes', 'selfbase',
                'create_page', '{"none":[]}', '{"doc":[]}', '"Container survives upgrade"')
            data = sql('SELECT id, title FROM page')
            assert 'Container survives upgrade' in data
            owner = sql('SELECT publisher_identity FROM module_install_meta')
            print('PASS: fresh pinned Docker image publishes and runs migrations before becoming healthy', flush=True)
            # Replace only the test artifact, keeping data and CLI credentials.
            subprocess.run(['docker', 'stop', '--time', '8', cid], check=True, stdout=subprocess.DEVNULL)
            module.write_bytes((ROOT / 'server/docker/server.wasm').read_bytes())
            subprocess.run(['docker', 'start', cid], check=True, stdout=subprocess.DEVNULL)
            wait_ready()
            assert sql('SELECT id, title FROM page') == data
            assert sql('SELECT publisher_identity FROM module_install_meta') == owner
            markers = sql('SELECT key, completed_at FROM migration_state')
            assert 'page_parent_pk_backfill_v2' in markers
            restart()
            wait_ready()
            assert sql('SELECT id, title FROM page') == data
            assert sql('SELECT publisher_identity FROM module_install_meta') == owner
            assert sql('SELECT key, completed_at FROM migration_state') == markers
            print('PASS: old-to-new container upgrade and repeat restart preserve data, owner and completed migration markers', flush=True)
            subprocess.run(['docker', 'stop', '--time', '8', cid], check=True, stdout=subprocess.DEVNULL)
            module.write_bytes(b'invalid-regression-only-wasm')
            subprocess.run(['docker', 'start', cid], check=True, stdout=subprocess.DEVNULL)
            wait_ready('publish-failed')
            assert sql('SELECT id, title FROM page') == data
            assert sql('SELECT publisher_identity FROM module_install_meta') == owner
            assert sql('SELECT key, completed_at FROM migration_state') == markers
            print('PASS: failed publish leaves existing database/identity intact and container unhealthy', flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', cid], check=True, stdout=subprocess.DEVNULL)
            # The image runs as root; return ownership of this test directory
            # after stopping it, before TemporaryDirectory removes its files.
            subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--user', 'root',
                '-v', str(state) + ':/test-state', '--entrypoint', 'chown', IMAGE,
                '-R', f'{os.getuid()}:{os.getgid()}', '/test-state'], check=True)


if __name__ == '__main__': main()
