#!/usr/bin/env python3
"""Disposable SpacetimeDB snapshot-import integrity/transaction regressions.

Uses temporary data/keys/config and localhost only. No live workspace is touched.
"""
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
from regression_config import BASELINES, BIN, MODULE_WASM
POLICY = json.loads((ROOT / "server/spacetimedb/snapshot_tables_v2.json").read_text())["include"]


def main():
    with tempfile.TemporaryDirectory(prefix="selfbase-snapshot-regressions-") as directory:
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

                old = temp / "baseline.wasm"
                baseline_path = os.environ.get("TEST_BASELINE_WASM")
                old.write_bytes(Path(baseline_path).read_bytes() if baseline_path else subprocess.check_output(
                    ["git", "show", f"{BASELINES['snapshots']}:server/docker/server.wasm"], cwd=ROOT))
                publish(old, "snapshot-baseline")
                token = re.search(r"eyJ[A-Za-z0-9_.-]+", (temp / "config/spacetime/cli.toml").read_text()).group()

                def request(db, path, body, fail=False):
                    sql = path == "sql"
                    data = body if sql else json.dumps(body)
                    req = urllib.request.Request(f"{base}/v1/database/{db}/{path}", data=data.encode(),
                        headers={"Authorization": "Bearer " + token, "Content-Type": "text/plain" if sql else "application/json"})
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

                def setup(db):
                    call(db, "register", ["snapshot-test@example.test", "Restore test", "regression-only-password"])
                    call(db, "import_v_2_begin", [json.dumps({"format": "selfbase-snapshot-v2"})])

                timestamp = {"__selfbase": "timestamp", "v": "1700000000000000"}

                def identity_of(row):
                    identity = row["identity"]
                    if isinstance(identity, list):
                        identity = identity[0]
                    return identity.removeprefix("0x")

                def user_row(identity):
                    return {"identity": {"__selfbase": "identity", "v": identity}, "name": "Restored user",
                        "email": "source@example.test", "isAuthenticated": False, "isAdmin": False,
                        "createdAt": timestamp, "lastSeenAt": timestamp}

                setup("snapshot-baseline")
                original_identity = identity_of(sql("snapshot-baseline", "SELECT identity FROM user")[0])
                call("snapshot-baseline", "import_v_2_chunk", [1, "user", json.dumps([user_row(original_identity)])])
                imported_identity = identity_of(sql("snapshot-baseline", "SELECT identity FROM user WHERE name = 'Restored user'")[0])
                assert imported_identity == bytes.fromhex(original_identity)[::-1].hex()
                assert imported_identity != original_identity
                print("CONFIRMED baseline: restored identities were byte-reversed", flush=True)
                call("snapshot-baseline", "import_v_2_commit", [json.dumps({"counts": {}})])
                print("CONFIRMED baseline: empty manifest committed without accounting for imported tables", flush=True)

                publish(MODULE_WASM, "snapshot-fixed")
                db = "snapshot-fixed"
                setup(db)
                for counts in [{}, {"page": 0}, {**dict.fromkeys(POLICY, 0), "unknown": 0}]:
                    assert "manifest" in call(db, "import_v_2_commit", [json.dumps({"counts": counts})], fail=True)
                assert len(sql(db, "SELECT * FROM import_session")) == 1
                print("PASS: incomplete/unknown manifests rejected; session retained", flush=True)

                timestamp = {"__selfbase": "timestamp", "v": "1700000000000000"}
                setting = {"id": 40, "key": "snapshot-regression", "valueJson": "{}", "updatedAt": timestamp,
                           "updatedBy": {"__selfbase": "identity", "v": "0" * 64}}
                call(db, "import_v_2_chunk", [1, "workspace_setting", json.dumps([setting])])
                bad_chunk = [{**setting, "id": 41, "key": "must-roll-back"}, {"id": 42}]
                call(db, "import_v_2_chunk", [2, "workspace_setting", json.dumps(bad_chunk)], fail=True)
                assert len(sql(db, "SELECT * FROM workspace_setting")) == 1
                assert sql(db, "SELECT last_seq FROM import_session")[0]["last_seq"] == 1
                counts = dict.fromkeys(POLICY, 0)
                assert "mismatch" in call(db, "import_v_2_commit", [json.dumps({"counts": counts})], fail=True).lower()
                counts["workspace_setting"] = 1
                call(db, "import_v_2_commit", [json.dumps({"counts": counts})])
                assert sql(db, "SELECT * FROM import_session") == []
                print("PASS: invalid chunk rolls back its own rows; earlier chunks survive; complete matching manifest commits", flush=True)

                setup_begin = json.dumps({"format": "selfbase-snapshot-v2"})
                call(db, "import_v_2_begin", [setup_begin])
                setting["id"] = 43
                setting["key"] = "abort-retains-data"
                call(db, "import_v_2_chunk", [1, "workspace_setting", json.dumps([setting])])
                call(db, "import_v_2_abort", [])
                assert len(sql(db, "SELECT * FROM workspace_setting")) == 2
                print("PASS: abort is not rollback (previous chunks remain)", flush=True)
                # The CLI commonly restores using the same publisher identity
                # present in the backup. Verify the bootstrap row does not collide.
                call(db, "import_v_2_begin", [setup_begin])
                identity = identity_of(sql(db, "SELECT identity FROM user")[0])
                call(db, "import_v_2_chunk", [1, "user", json.dumps([user_row(identity)])])
                restored = sql(db, "SELECT * FROM user")
                assert len(restored) == 1 and identity_of(restored[0]) == identity
                assert restored[0]["name"] == "Restored user"
                assert restored[0]["is_authenticated"] and restored[0]["is_admin"]
                counts = dict.fromkeys(POLICY, 0)
                counts["user"] = 1
                call(db, "import_v_2_commit", [json.dumps({"counts": counts})])
                print("PASS: same-identity restore preserves identity/profile and bootstrap login/admin access", flush=True)
                # Full SDK export/clear/import, followed by the real CLI path.
                publish(MODULE_WASM, "snapshot-roundtrip")
                exported = temp / "roundtrip.json"
                test_env = dict(env, SNAPSHOT_TEST_TOKEN=token, SNAPSHOT_TEST_OUTPUT=str(exported), SPACETIME_CLI=str(BIN / "spacetimedb-cli"))
                result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "scripts/snapshot-v2-e2e.ts", "snapshot-roundtrip", base.replace("http:", "ws:"),
                    str(MODULE_WASM)], cwd=ROOT / "web", env=test_env,
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
                assert result.returncode == 0, result.stdout
                print(result.stdout, flush=True)

                # Publish a fresh target first, so this also checks the CLI's
                # same-identity bootstrap path without any production endpoint.
                publish(MODULE_WASM, "snapshot-cli")
                cli_env = dict(env, SELFBASE_URL=base, SELFBASE_TOKEN=token)
                result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "scripts/restore-snapshot.ts", str(exported), "snapshot-cli"],
                    cwd=ROOT / "web", env=cli_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
                assert result.returncode == 0, result.stdout
                print(result.stdout, flush=True)
                restored = json.loads(exported.read_text())
                assert len(sql("snapshot-cli", "SELECT * FROM page")) == restored["counts"]["page"]
                bad_file = temp / "invalid.json"
                bad_file.write_text(json.dumps({**restored, "counts": {}}))
                result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "scripts/restore-snapshot.ts", str(bad_file), "must-not-be-created"],
                    cwd=ROOT / "web", env=cli_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
                assert result.returncode != 0 and "counts." in result.stdout, result.stdout
                assert token not in result.stdout
                request("must-not-be-created", "sql", "SELECT * FROM page", fail=True)
                print("PASS: SDK round-trip, real CLI restore, and malformed-file rejection before destination creation", flush=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)


if __name__ == "__main__":
    main()
