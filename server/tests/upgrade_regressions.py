#!/usr/bin/env python3
"""Disposable SpacetimeDB upgrade/migration regressions.

Uses temporary data/keys/config and localhost only. No live workspace is touched.
"""
import io
import tarfile
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(os.environ.get("TEST_SPACETIME_BIN_DIR", str(Path.home() / ".local/share/spacetime/bin/2.0.3")))
POLICY = json.loads((ROOT / "server/spacetimedb/snapshot_tables_v2.json").read_text())["include"]


def main():
    with tempfile.TemporaryDirectory(prefix="selfbase-upgrade-regressions-") as directory:
        temp = Path(directory)
        env = dict(os.environ, XDG_CONFIG_HOME=str(temp / "config"))
        for args in [["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(temp / "private.pem")],
                     ["openssl", "ec", "-in", str(temp / "private.pem"), "-pubout", "-out", str(temp / "public.pem")]]:
            subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        with (temp / "server.log").open("w+") as log:
            server = subprocess.Popen([str(BIN / "spacetimedb-standalone"), "start", "--data-dir", str(temp / "data"),
                "--listen-addr", f"127.0.0.1:{port}", "--non-interactive", "--page_pool_max_size", "67108864",
                "--jwt-priv-key-path", str(temp / "private.pem"), "--jwt-pub-key-path", str(temp / "public.pem")], stdout=log, stderr=log)
            try:
                for _ in range(120):
                    assert server.poll() is None, "Disposable server exited"
                    try:
                        urllib.request.urlopen(base + "/v1/ping", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise AssertionError("Server startup timed out")

                def publish(path, db):
                    result = subprocess.run([str(BIN / "spacetimedb-cli"), "publish", "--server", base, "--yes", "--no-config",
                        "--break-clients", "--bin-path", str(path), db], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    assert result.returncode == 0, result.stdout

                fixture = temp / "fixture"
                fixture.mkdir()
                archive = subprocess.check_output(["git", "archive", "4cd90eb", "server/spacetimedb/src"], cwd=ROOT)
                with tarfile.open(fileobj=io.BytesIO(archive)) as files:
                    files.extractall(fixture, filter="data")
                crate = fixture / "server/spacetimedb"
                manifest = (ROOT / "server/spacetimedb/Cargo.toml").read_text().replace('name = "server"', 'name = "upgrade_fixture"', 1)
                (crate / "Cargo.toml").write_text(manifest)
                seed = r'''
#[reducer]
pub fn seed_upgrade_fixture(ctx: &ReducerContext) {
    use crate::auth::{user_credential, UserCredential};
    use crate::migrations::{migration_state, MigrationState};
    let credential = ctx.db.user_credential().email().find(&"legacy@example.test".to_string()).unwrap();
    ctx.db.user_credential().email().update(UserCredential { is_admin: false, ..credential });
    ctx.db.migration_state().insert(MigrationState {
        key: "page_parent_pk_backfill_v1".into(), completed_at: ctx.timestamp, module_version: "legacy".into(),
    });
    for (id, parent, deleted) in [(100, None, true), (101, Some(100), true), (102, Some(101), false)] {
        ctx.db.page().insert(Page { id, parent_id: parent, parent_pk: 0,
            page_type: PageType::Doc, title: format!("Legacy {id}"), sort_order: 1000,
            created_by: crate::types::ActorType::Human, created_at: ctx.timestamp, updated_at: ctx.timestamp,
            deleted_at: if deleted {Some(ctx.timestamp)} else {None}, icon: None, is_hidden: false,
            content_format: crate::pages::PageContentFormat::BlockNote });
    }
    ctx.db.page_content().insert(PageContent { page_id: 102, content: "Preserved Україна".into(), updated_at: ctx.timestamp });
}
'''
                lib = crate / "src/lib.rs"
                lib.write_text(lib.read_text() + seed)
                target = ROOT / "server/spacetimedb/target"
                result = subprocess.run(["cargo", "build", "--offline", "--manifest-path", str(crate / "Cargo.toml"),
                    "--target-dir", str(target), "--target", "wasm32-unknown-unknown", "--release"],
                    cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
                assert result.returncode == 0, result.stdout
                publish(target / "wasm32-unknown-unknown/release/upgrade_fixture.wasm", "upgrade-regressions")
                token = re.search(r"eyJ[A-Za-z0-9_.-]+", (temp / "config/spacetime/cli.toml").read_text()).group()
                def request(db, path, body, fail=False, credential=None):
                    sql = path == "sql"
                    data = body if sql else json.dumps(body)
                    req = urllib.request.Request(f"{base}/v1/database/{db}/{path}", data=data.encode(),
                        headers={"Authorization": "Bearer " + (credential or token), "Content-Type": "text/plain" if sql else "application/json"})
                    try:
                        raw = urllib.request.urlopen(req, timeout=30).read().decode()
                        assert not fail, "Expected rejection: " + path
                        return json.loads(raw) if sql else raw
                    except urllib.error.HTTPError as error:
                        message = error.read().decode()
                        if fail:
                            return message
                        raise AssertionError(f"{path}: HTTP {error.code}: {message}") from error

                def call(db, name, args, fail=False):
                    return request(db, "call/" + name, args, fail)

                def sql(db, query):
                    result = request(db, "sql", query)[0]
                    columns = [c["name"]["some"] for c in result["schema"]["elements"]]
                    return [dict(zip(columns, row)) for row in result["rows"]]

                db = "upgrade-regressions"
                call(db, "register", ["legacy@example.test", "Legacy admin", "regression-only-password"])
                call(db, "seed_upgrade_fixture", [])
                assert not sql(db, "SELECT * FROM user_credential")[0]["is_admin"]
                before = sql(db, "SELECT id, title, parent_id, deleted_at FROM page")
                content = sql(db, "SELECT * FROM page_content")
                publish(ROOT / "server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", db)
                assert sql(db, "SELECT id, title, parent_id, deleted_at FROM page") == before
                assert sql(db, "SELECT * FROM page_content") == content
                call(db, "run_pending_migrations", [])
                assert sql(db, "SELECT parent_pk FROM page WHERE id = 101")[0]["parent_pk"] == 100
                assert sql(db, "SELECT parent_pk FROM page WHERE id = 102")[0]["parent_pk"] == 101
                assert sql(db, "SELECT * FROM user_credential")[0]["is_admin"]
                assert len(sql(db, "SELECT * FROM trash_purge_tick")) == 1
                assert sql(db, "SELECT * FROM page_content") == content
                markers = sql(db, "SELECT * FROM migration_state")
                call(db, "run_pending_migrations", [])
                assert sql(db, "SELECT * FROM migration_state") == markers
                assert len(sql(db, "SELECT * FROM trash_purge_tick")) == 1
                print("PASS: in-place upgrade preserves data; v2 repairs trash indexes; admin authority is migrated; repeat migrations are idempotent", flush=True)
                identity = json.load(urllib.request.urlopen(urllib.request.Request(base + "/v1/identity", data=b"")))
                request(db, "call/login", ["legacy@example.test", "regression-only-password"], credential=identity["token"])
                assert all(user["is_admin"] for user in sql(db, "SELECT * FROM user WHERE email = 'legacy@example.test'"))
                call(db, "create_local_user", ["member@example.test", "Member", "regression-only-password"])
                member = json.load(urllib.request.urlopen(urllib.request.Request(base + "/v1/identity", data=b"")))["token"]
                request(db, "call/login", ["member@example.test", "regression-only-password"], credential=member)
                assert "admin or publisher" in request(db, "call/run_pending_migrations", [], fail=True, credential=member)
                assert sql(db, "SELECT * FROM migration_state") == markers
                print("PASS: admin role survives a new device; ordinary members cannot invoke migrations", flush=True)
                publish(ROOT / "server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", db)
                call(db, "run_pending_migrations", [])
                assert sql(db, "SELECT * FROM migration_state") == markers
                assert sql(db, "SELECT * FROM page_content") == content
                call(db, "purge_page", [100])
                assert sql(db, "SELECT * FROM page WHERE id = 101") == []
                assert sql(db, "SELECT parent_pk FROM page WHERE id = 102")[0]["parent_pk"] == 0
                assert sql(db, "SELECT * FROM page_content") == content
                print("PASS: repeat publish preserves data; repaired trash indexes support complete subtree purge", flush=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)


if __name__ == "__main__":
    main()
