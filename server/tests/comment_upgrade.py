#!/usr/bin/env python3
"""Real 2.0.3 upgrade test. Requires Rust wasm32 target and installed CLI/server.

TEST_SPACETIME_BIN_DIR=/path/to/2.0.3 python3 server/tests/comment_upgrade.py
Uses a temporary database, data directory and CLI credentials; never production.
"""
import io
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
from regression_config import BASELINES, BIN, MODULE_WASM, TARGET_DIR
BAD = BASELINES["comments"]
CLI = str(BIN / 'spacetimedb-cli')
SERVER = str(BIN / 'spacetimedb-standalone')
SEED = r'''
#[reducer]
pub fn seed_upgrade_fixture(ctx: &ReducerContext) {
    use crate::auth::{user, User};
    let row = User {
        identity: ctx.sender(), name: "Upgrade fixture".into(),
        email: "  Legacy@Example.COM  ".into(), is_authenticated: false,
        created_at: ctx.timestamp, last_seen_at: ctx.timestamp, is_admin: false,
    };
    if ctx.db.user().identity().find(ctx.sender()).is_some() {
        ctx.db.user().identity().update(row);
    } else { ctx.db.user().insert(row); }
    use crate::migrations::{migration_state, MigrationState};
    ctx.db.migration_state().insert(MigrationState {
        key: "block_comment_author_email_backfill_v1".into(),
        completed_at: ctx.timestamp, module_version: "test".into(),
    });
    for id in 41..=43 {
        ctx.db.block_comment().insert(BlockComment {
            id, page_id: 987, block_id: Some("preserved-anchor".into()),
            parent_id: if id == 42 { Some(41) } else { None },
            author: if id == 43 { ctx.identity() } else { ctx.sender() },
            content: format!("Legacy comment {id}: Україна"), resolved: id == 41,
            created_at: ctx.timestamp, updated_at: ctx.timestamp,
        });
    }
}

#[reducer]
pub fn seed_upgrade_account(ctx: &ReducerContext) {
    use crate::auth::{user, User};
    let row = User {
        identity: ctx.sender(), name: "Second device".into(),
        email: "legacy@example.com".into(), is_authenticated: true,
        created_at: ctx.timestamp, last_seen_at: ctx.timestamp, is_admin: false,
    };
    if ctx.db.user().identity().find(ctx.sender()).is_some() {
        ctx.db.user().identity().update(row);
    } else { ctx.db.user().insert(row); }
}
'''


def run(args, env, check=True):
    p = subprocess.run([str(a) for a in args], cwd=ROOT, env=env,
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if check and p.returncode:
        raise AssertionError(f'{args}\n{p.stdout}')
    return p


def main():
    assert 'tool version 2.0.3;' in subprocess.check_output([CLI, '--version'], text=True)
    with tempfile.TemporaryDirectory(prefix='selfbase-upgrade-') as tmp:
        tmp = Path(tmp)
        env = dict(os.environ, XDG_CONFIG_HOME=str(tmp / 'config'),
                   CARGO_HOME=os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')),
                   RUSTUP_HOME=os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')),
                   CARGO_TARGET_DIR=str(TARGET_DIR / 'comment-upgrade'))
        old = tmp / 'old'
        old.mkdir()
        archive = subprocess.check_output(['git', 'archive', BAD + '^', 'server/spacetimedb'], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(old, filter='data')
        module = old / 'server/spacetimedb'
        with (module / 'src/comments.rs').open('a') as f:
            f.write(SEED)
        print('Building legacy fixture with SDK 2.0.3...', flush=True)
        run([CLI, 'build', '--module-path', module], env)
        old_wasm = tmp / 'old.wasm'
        old_wasm.write_bytes((Path(env['CARGO_TARGET_DIR']) / 'wasm32-unknown-unknown/release/server.wasm').read_bytes())
        bad_wasm = tmp / 'bad.wasm'
        bad_wasm.write_bytes(subprocess.check_output(['git', 'show', BAD + ':server/docker/server.wasm'], cwd=ROOT))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        run(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256',
             '-out', tmp / 'jwt-private.pem'], env)
        run(['openssl', 'ec', '-in', tmp / 'jwt-private.pem', '-pubout',
             '-out', tmp / 'jwt-public.pem'], env)
        with (tmp / 'server.log').open('w+') as log:
            server = subprocess.Popen([SERVER, 'start', '--data-dir', str(tmp / 'data'),
                                       '--listen-addr', f'127.0.0.1:{port}', '--non-interactive',
                                       '--jwt-priv-key-path', str(tmp / 'jwt-private.pem'),
                                       '--jwt-pub-key-path', str(tmp / 'jwt-public.pem'),
                                       '--page_pool_max_size', '67108864'], env=env, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    assert server.poll() is None, 'Test server exited'
                    try:
                        urllib.request.urlopen(url + '/v1/ping', timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.25)
                else:
                    raise AssertionError('Test server startup timed out')
                db = 'comment-upgrade'
                def cli(command, *args, check=True):
                    return run([CLI, command, '--server', url, '--yes', '--no-config', *args], env, check)
                def publish(wasm, check=True):
                    return cli('publish', '--bin-path', wasm, '--break-clients', db, check=check)
                def sql(query):
                    return '\n'.join(sorted(cli('sql', db, query).stdout.splitlines()))
                other_env = dict(env, XDG_CONFIG_HOME=str(tmp / 'other-config'))
                def other_cli(command, *args, check=True):
                    return run([CLI, command, '--server', url, '--yes', '--no-config',
                                db, *args], other_env, check)
                publish(old_wasm)
                cli('call', db, 'seed_upgrade_fixture')
                other_cli('call', 'seed_upgrade_account')
                columns = 'id, page_id, block_id, parent_id, author, content, resolved, created_at, updated_at'
                query = f'SELECT {columns} FROM block_comment'
                before = sql(query)
                assert all(f'Legacy comment {i}' in before for i in (41, 42, 43)), before
                rejected = publish(bad_wasm, check=False)
                assert rejected.returncode != 0 and 'Reordering table block_comment' in rejected.stdout, rejected.stdout
                assert sql(query) == before, 'Rejected publish changed legacy rows'
                print('PASS: original WASM rejected; all legacy data preserved', flush=True)
                publish(MODULE_WASM)
                assert sql(query) == before, 'Upgrade changed legacy columns'
                defaults = sql('SELECT id, author_email FROM block_comment')
                assert 'legacy@example.com' not in defaults, defaults
                print('PASS: appended default column accepted by 2.0.3; all legacy columns preserved', flush=True)
                cli('call', db, 'run_pending_migrations')
                linked = sql('SELECT id, author_email FROM block_comment')
                assert linked.count('legacy@example.com') == 2, linked
                assert sql(query) == before, 'Backfill changed legacy columns'
                cli('call', db, 'run_pending_migrations')
                cli('call', db, 'backfill_comment_authors')
                assert sql('SELECT id, author_email FROM block_comment') == linked
                state = sql("SELECT key FROM migration_state WHERE key = 'block_comment_author_email_backfill_v2'")
                assert state.count('block_comment_author_email_backfill_v2') == 1, state
                print('PASS: normalized account backfill, unlinked orphan, idempotent migrations', flush=True)
                publish(MODULE_WASM)
                assert sql(query) == before
                assert sql('SELECT id, author_email FROM block_comment') == linked
                print('PASS: repeat publish retains data and email snapshots', flush=True)
                denied = other_cli('call', 'update_block_comment', '43', '"forbidden"', check=False)
                assert denied.returncode != 0 and 'Only the author' in denied.stdout, denied.stdout
                other_cli('call', 'update_block_comment', '41', '"Edited from second device"')
                other_cli('call', 'resolve_block_comment', '41', 'false')
                other_cli('call', 'delete_block_comment', '42')
                assert 'Edited from second device' in sql('SELECT content FROM block_comment WHERE id = 41')
                assert 'Legacy comment 42' not in sql('SELECT content FROM block_comment')
                print('PASS: different non-admin identity with same email can edit/resolve/delete; orphan protected', flush=True)
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read()[-8000:])
                raise
            finally:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    main()
