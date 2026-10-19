"""Shared local toolchain and candidate artifact for disposable regressions."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
def repo_path(value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else ROOT / path).resolve()


BIN = repo_path(os.environ.get('TEST_SPACETIME_BIN_DIR', str(Path.home() / '.local/share/spacetime/bin/2.0.3')))
TARGET_DIR = repo_path(os.environ.get('CARGO_TARGET_DIR', 'server/spacetimedb/target'))
MODULE_WASM = repo_path(os.environ.get('TEST_MODULE_WASM', str(TARGET_DIR / 'wasm32-unknown-unknown/release/server.wasm')))

# Reachable historical fixtures used to demonstrate pre-fix behavior.
BASELINES = {
    'external_sources': '79e9317',
    'snapshots': '139085ade52534c8f8bea31370b844d1ee459c25',
    'deletion': '84a26b0',
    'upgrades': '4cd90eb',
    'comments': '6fdfe255941ae3ddcfca28fa2ffabecc71151189',
}
