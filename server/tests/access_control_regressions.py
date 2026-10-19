#!/usr/bin/env python3
"""Isolated access-control / snapshot-import regressions.

Asserts the *fixed* behaviour for the P0 review findings:

  #1  a crafted snapshot cannot grant an imported identity workspace
      membership or admin rights (and the identity cannot perform admin work).
  #9a a crafted snapshot cannot silently publish an API endpoint
      (`requireAuth` is forced to true on restore).
  #9b API keys are never imported from a snapshot (no planted credentials).
  #4  moving a restricted page out of a restricted ancestor keeps the
      restriction (the rule is materialized on the moved page).
  #5  deleting a subtree only trashes nodes the caller may write; a restricted
      child stays alive behind an open ancestor.

Uses a throwaway SpacetimeDB standalone on a random localhost port with a
temporary data dir + generated JWT keys. The live `selfbase` database, its
volumes and its deployed WASM are never touched.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server" / "tests"))
from regression_config import BIN, MODULE_WASM  # noqa: E402

POLICY = json.loads(
    (ROOT / "server/spacetimedb/snapshot_tables_v2.json").read_text()
)["include"]

TS = {"__selfbase": "timestamp", "v": "1700000000000000"}


def ident(hex_str):
    return {"__selfbase": "identity", "v": hex_str}


def resolve_identity(value):
    if isinstance(value, list):
        value = value[0]
    return value.removeprefix("0x")


def main():
    with tempfile.TemporaryDirectory(prefix="selfbase-access-regressions-") as directory:
        temp = Path(directory)
        env = dict(os.environ, XDG_CONFIG_HOME=str(temp / "config"))
        for args in [
            ["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
             "-out", str(temp / "private.pem")],
            ["openssl", "ec", "-in", str(temp / "private.pem"), "-pubout",
             "-out", str(temp / "public.pem")],
        ]:
            subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"

        with (temp / "server.log").open("w+") as log:
            server = subprocess.Popen(
                [str(BIN / "spacetimedb-standalone"), "start", "--data-dir", str(temp / "data"),
                 "--listen-addr", f"127.0.0.1:{port}", "--non-interactive",
                 "--page_pool_max_size", "67108864",
                 "--jwt-priv-key-path", str(temp / "private.pem"),
                 "--jwt-pub-key-path", str(temp / "public.pem")],
                stdout=log, stderr=log)
            try:
                for _ in range(120):
                    assert server.poll() is None, "Disposable server exited"
                    try:
                        urllib.request.urlopen(base + "/v1/ping", timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise AssertionError("Server startup timed out")

                def publish(path, db):
                    result = subprocess.run(
                        [str(BIN / "spacetimedb-cli"), "publish", "--server", base, "--yes",
                         "--no-config", "--break-clients", "--bin-path", str(path), db],
                        env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                    assert result.returncode == 0, result.stdout

                db = "access-control-fixed"
                publish(MODULE_WASM, db)
                token = re.search(
                    r"eyJ[A-Za-z0-9_.-]+",
                    (temp / "config/spacetime/cli.toml").read_text(),
                ).group()

                def request(path, body, fail=False, credential=None):
                    is_sql = path == "sql"
                    data = body if is_sql else json.dumps(body)
                    req = urllib.request.Request(
                        f"{base}/v1/database/{db}/{path}", data=data.encode(),
                        headers={"Authorization": "Bearer " + (credential or token),
                                 "Content-Type": "text/plain" if is_sql else "application/json"})
                    try:
                        raw = urllib.request.urlopen(req, timeout=30).read().decode()
                        assert not fail, f"Expected rejection: {path}"
                        return json.loads(raw) if is_sql else raw
                    except urllib.error.HTTPError as error:
                        message = error.read().decode()
                        if fail:
                            return message
                        raise AssertionError(f"{path}: HTTP {error.code}: {message}") from error

                def call(name, args, fail=False, credential=None):
                    return request("call/" + name, args, fail, credential)

                def sql(query):
                    result = request("sql", query)[0]
                    columns = [c["name"]["some"] for c in result["schema"]["elements"]]
                    return [dict(zip(columns, row)) for row in result["rows"]]

                def new_identity():
                    raw = urllib.request.urlopen(
                        urllib.request.Request(base + "/v1/identity", data=b""),
                        timeout=10).read().decode()
                    payload = json.loads(raw)
                    assert payload.get("identity"), payload
                    return payload["identity"].removeprefix("0x"), payload["token"]

                def page(pid, parent=None, database=False):
                    return {"id": pid, "parentId": parent,
                            "pageType": {"tag": "Database" if database else "Doc"},
                            "title": str(pid), "sortOrder": 1000,
                            "createdBy": {"tag": "Human"}, "createdAt": TS,
                            "updatedAt": TS, "deletedAt": None}

                # ── bootstrap owner/admin + two ordinary members ────────────────
                call("register", ["owner@example.test", "Owner", "owner-regression-password"])
                owner = sql("SELECT identity FROM user WHERE email = 'owner@example.test'")
                assert owner, "owner row missing after register"
                owner_id = resolve_identity(owner[0]["identity"])

                call("create_local_user", ["alice@example.test", "Alice", "alice-regression-password"])
                call("create_local_user", ["bob@example.test", "Bob", "bob-regression-password"])
                alice_id, alice_tok = new_identity()
                bob_id, bob_tok = new_identity()
                call("login", ["alice@example.test", "alice-regression-password"], credential=alice_tok)
                call("login", ["bob@example.test", "bob-regression-password"], credential=bob_tok)

                attacker_id, attacker_tok = new_identity()
                known_key_hash = hashlib.sha256(b"attacker-known-secret").hexdigest()

                # ── crafted, untrusted snapshot ────────────────────────────────
                chunks = {
                    "user": [
                        {"identity": ident(attacker_id), "name": "Attacker",
                         "email": "attacker@example.test", "isAuthenticated": True,
                         "isAdmin": True, "createdAt": TS, "lastSeenAt": TS},
                    ],
                    "page": [page(100), page(101, 100),
                             page(200, database=True), page(201, 200, database=True)],
                    "page_access_rule": [
                        {"id": 1, "pageId": 100,
                         "principal": {"tag": "WorkspaceMember", "value": ident(alice_id)},
                         "permission": {"tag": "Write"}, "grantedBy": ident(owner_id),
                         "grantedAt": TS},
                        {"id": 2, "pageId": 201,
                         "principal": {"tag": "WorkspaceMember", "value": ident(alice_id)},
                         "permission": {"tag": "Write"}, "grantedBy": ident(owner_id),
                         "grantedAt": TS},
                    ],
                    "api_endpoint": [
                        {"id": 1, "databasePageId": 201, "slug": "imported-backdoor",
                         "displayName": "Imported backdoor", "description": "",
                         "allowedMethods": ["Get"], "requireAuth": False,
                         "createdBy": ident(attacker_id), "createdAt": TS,
                         "updatedAt": TS},
                    ],
                    "api_endpoint_key": [
                        {"id": 1, "endpointId": 1, "keyHash": known_key_hash,
                         "label": "attacker-key", "allowedMethods": ["Get"],
                         "createdBy": ident(attacker_id), "createdAt": TS,
                         "lastUsedAt": None, "expiresAt": None},
                    ],
                }

                call("import_v_2_begin", [json.dumps({"format": "selfbase-snapshot-v2"})])
                for seq, (table, rows) in enumerate(chunks.items(), 1):
                    call("import_v_2_chunk", [seq, table, json.dumps(rows)])
                counts = dict.fromkeys(POLICY, 0)
                for table, rows in chunks.items():
                    counts[table] = len(rows)
                call("import_v_2_commit", [json.dumps({"counts": counts})])

                # #1: imported privilege flags are ignored.
                attacker = sql(
                    "SELECT is_admin, is_authenticated FROM user "
                    "WHERE email = 'attacker@example.test'")[0]
                assert attacker["is_admin"] is False, attacker
                assert attacker["is_authenticated"] is False, attacker
                rejection = call("set_workspace_setting",
                                 ["ai.max_hops", "5"], fail=True, credential=attacker_tok)
                assert "admin" in rejection.lower(), rejection
                print("ok  #1 imported identity cannot gain membership/admin rights", flush=True)

                # #9a: restored endpoints start closed.
                endpoint = sql(
                    "SELECT require_auth FROM api_endpoint WHERE slug = 'imported-backdoor'")
                assert endpoint and endpoint[0]["require_auth"] is True, endpoint
                print("ok  #9a restored API endpoint is forced to require auth", flush=True)

                # #9b: credential rows are skipped, not imported.
                keys = sql("SELECT key_hash FROM api_endpoint_key")
                assert keys == [], keys
                print("ok  #9b snapshot API keys are not imported", flush=True)

                # #4: reparenting keeps the inherited restriction.
                denied = call("authorize_blob_access", [101, False],
                              fail=True, credential=bob_tok)
                assert "read access" in denied, denied
                call("move_page", [101, None, None], credential=alice_tok)
                moved = sql("SELECT parent_pk FROM page WHERE id = 101")[0]
                assert moved["parent_pk"] == 0, moved
                still_denied = call("authorize_blob_access", [101, False],
                                    fail=True, credential=bob_tok)
                assert "read access" in still_denied, still_denied
                materialized = sql("SELECT * FROM page_access_rule WHERE page_id = 101")
                assert materialized, "moved page lost its inherited rule"
                print("ok  #4 move_page preserves the inherited restriction", flush=True)

                # #5: an open ancestor cannot trash a restricted child.
                denied = call("authorize_blob_access", [201, True],
                              fail=True, credential=bob_tok)
                assert "write access" in denied, denied
                call("delete_page_subtree", [200], credential=bob_tok)
                rows = sql("SELECT id, deleted_at FROM page")
                by_id = {row["id"]: row["deleted_at"] for row in rows
                         if row["id"] in (200, 201)}

                def is_none(value):
                    if value is None:
                        return True
                    if isinstance(value, list) and len(value) == 2 and value[0] == 1:
                        return True
                    return isinstance(value, dict) and "none" in value

                assert not is_none(by_id.get(200)), by_id
                assert is_none(by_id.get(201)), by_id
                print("ok  #5 delete_page_subtree skips unwritable descendants", flush=True)

                print("PASS: access-control regressions (isolated)", flush=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)


if __name__ == "__main__":
    main()
