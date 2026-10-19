#!/usr/bin/env python3
"""Run existing SELFbase checks with explicit prerequisites and fail-fast results."""
import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server/tests'))
from regression_config import BASELINES, BIN, TARGET_DIR  # noqa: E402


@dataclass(frozen=True)
class Step:
    name: str
    command: tuple[str, ...]
    directory: str = '.'
    timeout: int = 600


def node_tool(package, tool):
    return str(ROOT / package / 'node_modules/.bin' / tool)


def python_test(name):
    return (sys.executable, str(ROOT / 'server/tests' / name))


WASM = Step('Build candidate WASM', ('cargo', 'build', '--manifest-path', str(ROOT / 'server/spacetimedb/Cargo.toml'),
    '--target', 'wasm32-unknown-unknown', '--release', '--target-dir', str(TARGET_DIR)))
QUICK = [
    Step('Runner self-checks', (sys.executable, str(ROOT / 'scripts/test_check.py')), timeout=60),
    Step('Web unit tests', (node_tool('web', 'vitest'), 'run'), 'web'),
    Step('Editor unit tests', (node_tool('packages/pulp', 'vitest'), 'run'), 'packages/pulp'),
    *[Step(f'TypeScript: {package}', (node_tool(package, 'tsc'), '--noEmit', '--incremental', 'false'), package)
      for package in ['web', 'packages/pulp', 'packages/snapshot-core']],
    Step('TypeScript: manual regression probes', (node_tool('web', 'tsc'), '--project', str(ROOT / 'server/tests/tsconfig.json'), '--noEmit', '--incremental', 'false')),
    Step('Rust unit tests', ('cargo', 'test', '--manifest-path', str(ROOT / 'server/spacetimedb/Cargo.toml'), '--release')),
    Step('Entrypoint compatibility tests', python_test('test_entrypoint.py'), timeout=60),
    Step('Entrypoint readiness tests', python_test('entrypoint_readiness.py'), timeout=60),
]
INTEGRATION = [WASM, *[Step(name, python_test(file)) for name, file in [
    ('External-source regressions', 'external_source_regressions.py'),
    ('Snapshot restore regressions', 'snapshot_restore_regressions.py'),
    ('Deletion regressions', 'deletion_regressions.py'),
    ('Upgrade and migration regressions', 'upgrade_regressions.py'),
    ('Comment schema upgrade regressions', 'comment_upgrade.py'),
]]]
BROWSER = [Step('Editor browser regressions', ('node', str(ROOT / 'packages/pulp/tests/autosave-browser.mjs')), timeout=180)]
DOCKER = [WASM, Step('Container upgrade regressions', python_test('container_upgrade.py'))]
BUILD = [WASM, Step('Production web build', (node_tool('web', 'next'), 'build'), 'web')]
PROFILES = {'quick': QUICK, 'integration': INTEGRATION, 'browser': BROWSER, 'docker': DOCKER, 'build': BUILD,
    'all': QUICK + INTEGRATION + BROWSER + DOCKER + BUILD}


def steps_for(profile):
    # The full run builds one candidate and uses it for every integration suite.
    return list(dict.fromkeys(PROFILES[profile]))


def probe(command):
    try:
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=15)
        return result.returncode == 0, result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)


def prerequisites(profile, steps):
    errors = []
    commands = {step.command[0] for step in steps}
    if profile != 'docker': commands.add('node')
    for command in sorted(commands):
        if not shutil.which(command):
            errors.append(f'Missing {command}. Install the toolchain or run pnpm install --frozen-lockfile.')
    if profile in ('quick', 'all'):
        for command in ('sh', 'timeout', 'sleep', 'date'):
            if not shutil.which(command): errors.append(f'Missing {command} (GNU coreutils required for readiness tests).')
    needs_wasm = WASM in steps
    if needs_wasm:
        ok, directory = probe(['rustc', '--print', 'target-libdir', '--target', 'wasm32-unknown-unknown'])
        if not ok or not Path(directory.strip()).is_dir():
            errors.append('Missing Rust WASM target. Run rustup target add wasm32-unknown-unknown.')
    if profile in ('integration', 'all'):
        if not shutil.which('openssl'): errors.append('Missing openssl.')
        for binary in ('spacetimedb-cli', 'spacetimedb-standalone'):
            ok, version = probe([str(BIN / binary), '--version'])
            if not ok or not re.search(r'tool version 2\.0\.3;', version):
                errors.append(f'Install SpacetimeDB 2.0.3 CLI + standalone; TEST_SPACETIME_BIN_DIR currently points to {BIN}.')
        for tool in ('vitest', 'tsx'):
            if not Path(node_tool('web', tool)).is_file(): errors.append(f'Missing web {tool}; run pnpm install --frozen-lockfile.')
    if profile in ('integration', 'docker', 'all'):
        if not shutil.which('git'): errors.append('Missing git.')
        revisions = BASELINES.values() if profile != 'docker' else [BASELINES['upgrades']]
        for revision in revisions:
            if not probe(['git', 'cat-file', '-e', f'{revision}:server/docker/server.wasm'])[0]:
                errors.append(f'Missing regression baseline {revision}. Fetch full repository history (git fetch --unshallow origin for a shallow clone).')
    if profile in ('docker', 'all'):
        if not probe(['docker', 'info', '--format', '{{.ServerVersion}}'])[0]: errors.append('Docker daemon is unavailable.')
        if not probe(['docker', 'compose', 'version'])[0]: errors.append('Docker Compose v2 is required.')
        if not probe(['docker', 'image', 'inspect', 'clockworklabs/spacetime:v2.0.3'])[0]:
            errors.append('Missing pinned Docker image. Run docker pull clockworklabs/spacetime:v2.0.3.')
    if profile in ('browser', 'all'):
        ok, detail = probe(['node', '-e', "const fs=require('fs');const p=require(process.env.PLAYWRIGHT_MODULE||'playwright');if(!fs.existsSync(p.chromium.executablePath()))throw Error('Chromium is missing');"])
        if not ok:
            errors.append('Playwright/Chromium unavailable. Run pnpm install --frozen-lockfile, then pnpm exec playwright install chromium (or install --with-deps chromium if OS libraries are missing). PLAYWRIGHT_MODULE may point to another installation.')
    return list(dict.fromkeys(errors))


def stop_group(process):
    if process.poll() is not None: return
    for sig, seconds in [(signal.SIGINT, 10), (signal.SIGTERM, 5), (signal.SIGKILL, 5)]:
        try: os.killpg(process.pid, sig)
        except ProcessLookupError: return
        try:
            process.wait(timeout=seconds)
            return
        except subprocess.TimeoutExpired: pass


def run_step(step, env):
    started = time.monotonic()
    print(f'\n>>> {step.name}', flush=True)
    process = subprocess.Popen(step.command, cwd=ROOT / step.directory, env=env, start_new_session=True)
    try:
        status = process.wait(timeout=step.timeout)
    except subprocess.TimeoutExpired:
        print(f'TIMEOUT after {step.timeout}s: {step.name}', flush=True)
        stop_group(process)
        status = 124
    except KeyboardInterrupt:
        stop_group(process)
        raise
    elapsed = time.monotonic() - started
    print(f'{"PASS" if status == 0 else "FAIL"} {step.name} ({elapsed:.1f}s)', flush=True)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', nargs='?', choices=PROFILES, default='quick')
    parser.add_argument('--list', action='store_true', help='Show the plan without checking dependencies or executing commands')
    args = parser.parse_args()
    steps = steps_for(args.profile)
    if args.list:
        for index, step in enumerate(steps, 1): print(f'{index}. {step.name}')
        return 0
    errors = prerequisites(args.profile, steps)
    if errors:
        print('Cannot start checks:\n' + '\n'.join(f'- {error}' for error in errors), file=sys.stderr)
        return 2
    env = dict(os.environ, TEST_MODULE_WASM=str(TARGET_DIR / 'wasm32-unknown-unknown/release/server.wasm'))
    print(f'Profile: {args.profile} ({len(steps)} steps)', flush=True)
    if WASM in steps: print(f'Candidate: {env["TEST_MODULE_WASM"]}', flush=True)
    started = time.monotonic()
    completed = 0
    try:
        for step in steps:
            if run_step(step, env) != 0:
                print(f'\nFAILED: {completed}/{len(steps)} steps passed. Remaining steps were not run.', file=sys.stderr)
                return 1
            completed += 1
    except KeyboardInterrupt:
        print(f'\nCANCELLED: {completed}/{len(steps)} steps passed.', file=sys.stderr)
        return 130
    print(f'\nPASS: {completed}/{len(steps)} steps ({time.monotonic() - started:.1f}s).', flush=True)
    return 0


if __name__ == '__main__': sys.exit(main())
