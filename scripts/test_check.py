#!/usr/bin/env python3
"""Verify that scripts/check.py fails loudly, bounds hung steps and refuses missing tools."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.check import Step, run_step, steps_for, WASM  # noqa: E402


def failure_code_propagates():
    with contextlib.redirect_stdout(io.StringIO()):
        status = run_step(Step('Expected failure', (sys.executable, '-c', 'raise SystemExit(7)')), os.environ.copy())
    assert status == 7, f'failing step returned {status}, expected 7'


def hung_step_is_stopped_and_cleans_up():
    with tempfile.TemporaryDirectory() as folder:
        marker = Path(folder) / 'cleaned'
        code = ('import sys, time\n'
                'from pathlib import Path\n'
                'try:\n'
                '    time.sleep(60)\n'
                'except KeyboardInterrupt:\n'
                '    pass\n'
                'finally:\n'
                '    Path(sys.argv[1]).write_text("cleaned")')
        with contextlib.redirect_stdout(io.StringIO()):
            status = run_step(Step('Expected timeout', (sys.executable, '-c', code, str(marker)), timeout=1), os.environ.copy())
        assert status == 124, f'timed-out step returned {status}, expected 124'
        assert marker.read_text() == 'cleaned', 'hung child did not run its cleanup'


def wasm_is_built_once():
    assert steps_for('all').count(WASM) == 1, 'the all profile builds WASM more than once'


def missing_toolchain_is_refused():
    env = dict(os.environ, TEST_SPACETIME_BIN_DIR=str(Path(tempfile.gettempdir()) / 'selfbase-missing-toolchain'))
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/check.py'), 'integration'], cwd=ROOT, env=env,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    assert result.returncode == 2, f'missing toolchain exited with {result.returncode}, expected 2'
    assert 'Cannot start checks' in result.stdout, result.stdout
    assert 'Install SpacetimeDB 2.0.3' in result.stdout, result.stdout


def main():
    failure_code_propagates()
    hung_step_is_stopped_and_cleans_up()
    wasm_is_built_once()
    missing_toolchain_is_refused()
    print('PASS: runner propagates failures, stops hung steps with cleanup, builds WASM once and refuses missing toolchain')
    return 0


if __name__ == '__main__':
    sys.exit(main())
