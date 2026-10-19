#!/usr/bin/env python3
"""Disposable SpacetimeDB deletion lifecycle regressions.

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
    with tempfile.TemporaryDirectory(prefix="selfbase-deletion-regressions-") as directory:
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

                baseline = temp / "baseline.wasm"
                baseline.write_bytes(subprocess.check_output(["git", "show", f"{BASELINES['deletion']}:server/docker/server.wasm"], cwd=ROOT))
                publish(baseline, "deletion-baseline")
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

                ts = {"__selfbase": "timestamp", "v": "1700000000000000"}
                who = {"__selfbase": "identity", "v": "1" * 64}
                def page(id, parent=None, deleted=False, database=False):
                    return {"id": id, "parentId": parent, "pageType": {"tag": "Database" if database else "Doc"},
                        "title": str(id), "sortOrder": 1000, "createdBy": {"tag": "Human"}, "createdAt": ts,
                        "updatedAt": ts, "deletedAt": ts if deleted else None}
                def seed(db):
                    call(db, "register", ["deletion@example.test", "Tester", "regression-only-password"])
                    tables = {
                        "page": [page(100, deleted=True), page(101, 100), page(102, 100, True), page(110),
                                 page(200, database=True), page(201, 200), page(210, database=True), page(211, 210),
                                 page(300, deleted=True, database=True), page(301, database=True), page(302, 300),
                                 page(400), page(401, 400, True), page(402, 401),
                                 page(500), page(501, 500, True), page(502, 501)],
                        "database_schema": [{"id": 200, "pageId": 200, "name": "Parent"},
                            {"id": 210, "pageId": 210, "name": "Child", "parentSchemaId": 200},
                            {"id": 300, "pageId": 300, "name": "Deleted base"},
                            {"id": 301, "pageId": 301, "name": "Surviving derived", "parentSchemaId": 300}],
                        "property_definition": [{"id": 300, "schemaId": 300, "name": "Retained", "propertyType": {"tag": "Text"}, "config": "{}", "order": 0}, {"id": 200, "schemaId": 200, "name": "Shared", "propertyType": {"tag": "Text"}, "config": "{}", "order": 0},
                            {"id": 210, "schemaId": 210, "name": "Links", "propertyType": {"tag": "Relation"}, "config": "{}", "order": 1}],
                        "page_property_value": [{"id": 4, "pageId": 302, "propertyDefinitionId": 300, "value": {"tag": "Text", "value": "keep this data"}}, {"id": 1, "pageId": 201, "propertyDefinitionId": 200, "value": {"tag": "Text", "value": "parent"}},
                            {"id": 2, "pageId": 211, "propertyDefinitionId": 200, "value": {"tag": "Text", "value": "inherited"}},
                            {"id": 3, "pageId": 211, "propertyDefinitionId": 210, "value": {"tag": "Relation", "value": [100, 110]}}],
                        "page_property_value_history": [{"id": 1, "pageId": 211, "propertyDefinitionId": 200,
                            "value": {"tag": "Text", "value": "history"}, "isCurrent": True, "changedAt": ts, "changedBy": {"tag": "Human"}}],
                        "database_row_marker": [{"id": 1, "pageId": 100, "clientRequestId": "deleted-row", "createdAt": ts}],
                        "block_comment": [{"id": 1, "pageId": 100, "content": "root", "author": who, "resolved": False, "createdAt": ts, "updatedAt": ts},
                            {"id": 2, "pageId": 100, "parentId": 1, "content": "reply", "author": who, "resolved": False, "createdAt": ts, "updatedAt": ts},
                            {"id": 3, "pageId": 101, "content": "survives", "author": who, "resolved": False, "createdAt": ts, "updatedAt": ts}],
                        "page_access_rule": [{"id": 1, "pageId": 100, "principal": {"tag": "WorkspaceMember", "value": who},
                            "permission": {"tag": "Read"}, "grantedBy": who, "grantedAt": ts}],
                        "block_access_rule": [{"id": 1, "pageId": 100, "blockId": "block", "principal": {"tag": "WorkspaceMember", "value": who},
                            "permission": {"tag": "Read"}, "grantedBy": who, "grantedAt": ts}],
                    }
                    call(db, "import_v_2_begin", [json.dumps({"format": "selfbase-snapshot-v2"})])
                    for seq, (table, rows) in enumerate(tables.items(), 1):
                        call(db, "import_v_2_chunk", [seq, table, json.dumps(rows)])
                    counts = {table: len(tables.get(table, [])) for table in POLICY}
                    call(db, "import_v_2_commit", [json.dumps({"counts": counts})])
                    call(db, "request_page_access", [100, {"read": []}, "cleanup request"])

                seed("deletion-baseline")
                call("deletion-baseline", "purge_page", [100])
                assert len(sql("deletion-baseline", "SELECT * FROM block_comment WHERE page_id = 100")) == 2
                assert sql("deletion-baseline", "SELECT * FROM page_access_rule WHERE page_id = 101") == []
                call("deletion-baseline", "delete_property", [200])
                assert len(sql("deletion-baseline", "SELECT * FROM page_property_value WHERE property_definition_id = 200")) == 2
                print("CONFIRMED baseline: orphan comments/cells and lost inherited access after purge", flush=True)

                db = "deletion-fixed"
                publish(MODULE_WASM, db)
                seed(db)
                joined = sql(db, "SELECT database_schema.page_id, database_schema.config, page.deleted_at FROM database_schema JOIN page ON database_schema.page_id = page.id")
                assert len(joined) == 4
                call(db, "create_local_user", ["member@example.test", "Member", "regression-only-password"])
                member = json.load(urllib.request.urlopen(urllib.request.Request(base + "/v1/identity", data=b"")))["token"]
                request(db, "call/login", ["member@example.test", "regression-only-password"], credential=member)
                # A surviving ancestor's grant must remain inherited, not
                # materialized on the child: later revocation must take effect.
                identity = sql(db, "SELECT identity FROM user WHERE email = 'member@example.test'")[0]["identity"]
                call(db, "set_page_access_rule", [500, identity, {"read": []}])
                call(db, "set_page_access_rule", [500, ["0x" + "1" * 64], {"read": []}])
                request(db, "call/authorize_blob_access", [502, False], credential=member)
                call(db, "purge_page", [501])
                assert sql(db, "SELECT * FROM page WHERE id = 502")[0]["parent_pk"] == 500
                assert sql(db, "SELECT * FROM page_access_rule WHERE page_id = 502") == []
                request(db, "call/authorize_blob_access", [502, False], credential=member)
                call(db, "clear_page_access_rule", [500, identity])
                assert "read access" in request(db, "call/authorize_blob_access", [502, False], fail=True, credential=member)
                print("PASS: surviving ancestor grants remain inherited and revocation still removes access", flush=True)
                assert "read access" in request(db, "call/authorize_blob_access", [101, False], fail=True, credential=member)
                call(db, "purge_page", [100])
                assert "read access" in request(db, "call/authorize_blob_access", [101, False], fail=True, credential=member)
                assert sql(db, "SELECT * FROM database_row_marker WHERE page_id = 100") == []
                for table in ["block_comment", "page_access_rule", "block_access_rule", "page_access_request"]:
                    assert sql(db, f"SELECT * FROM {table} WHERE page_id = 100") == [], table
                assert len(sql(db, "SELECT * FROM block_comment WHERE page_id = 101")) == 1
                assert len(sql(db, "SELECT * FROM page_access_rule WHERE page_id = 101")) == 1
                assert sql(db, "SELECT * FROM page WHERE id = 101")[0]["parent_pk"] == 0
                assert sql(db, "SELECT * FROM page WHERE id = 102") == []
                relation = sql(db, "SELECT * FROM page_property_value WHERE id = 3")[0]
                assert "100" not in json.dumps(relation["value"]), relation
                assert "110" in json.dumps(relation["value"]), relation
                print("PASS: page data cleaned, live child preserved, grants retained and incoming relations repaired", flush=True)
                call(db, "create_api_endpoint", [210, "surviving", "Surviving", "", [{"get": []}], True])
                assert len(sql(db, "SELECT * FROM api_field_mapping WHERE property_definition_id = 200")) == 1
                call(db, "delete_property", [200])
                assert sql(db, "SELECT * FROM api_field_mapping WHERE property_definition_id = 200") == []
                for table in ["page_property_value", "page_property_value_history"]:
                    assert sql(db, f"SELECT * FROM {table} WHERE property_definition_id = 200") == [], table
                assert len(sql(db, "SELECT * FROM page_property_value WHERE id = 3")) == 1
                print("PASS: column deletion cleans inherited values/history and preserves unrelated columns", flush=True)
                original_stamp = sql(db, "SELECT * FROM page WHERE id = 401")[0]["deleted_at"]
                live_stamp = sql(db, "SELECT * FROM page WHERE id = 402")[0]["deleted_at"]
                call(db, "delete_page_subtree", [400])
                assert sql(db, "SELECT * FROM page WHERE id = 402")[0]["deleted_at"] != live_stamp
                assert sql(db, "SELECT * FROM page WHERE id = 401")[0]["deleted_at"] == original_stamp
                print("PASS: subtree deletion reaches live grandchildren below an already-trashed parent", flush=True)
                before = sql(db, "SELECT * FROM page")
                assert "inherits" in call(db, "purge_page", [300], fail=True)
                assert sql(db, "SELECT * FROM page") == before
                assert len(sql(db, "SELECT * FROM database_schema WHERE id = 300")) == 1
                call(db, "empty_trash", [])
                assert len(sql(db, "SELECT * FROM page WHERE id = 300")) == 1
                call(db, "set_schema_parent", [301, {"none": []}])
                assert "surviving rows" in call(db, "purge_page", [300], fail=True)
                assert len(sql(db, "SELECT * FROM page_property_value WHERE id = 4")) == 1
                assert sql(db, "SELECT * FROM page WHERE id = 302")[0]["parent_pk"] == 300
                call(db, "delete_page_subtree", [300])
                call(db, "purge_page", [300])
                assert sql(db, "SELECT * FROM database_schema WHERE id = 300") == []
                print("PASS: inherited schema preflight prevents partial writes; detach permits purge", flush=True)
                call(db, "delete_page", [110])
                stamp = sql(db, "SELECT * FROM page WHERE id = 110")[0]["deleted_at"]
                call(db, "delete_page", [110])
                assert sql(db, "SELECT * FROM page WHERE id = 110")[0]["deleted_at"] == stamp
                print("PASS: repeated soft delete preserves original timestamp", flush=True)
                call(db, "create_api_endpoint", [200, "to-purge", "Purge", "", [{"get": []}], True])
                endpoint = sql(db, "SELECT * FROM api_endpoint WHERE database_page_id = 200")[0]["id"]
                call(db, "create_api_endpoint_key", [endpoint, "a" * 64, "Regression", [{"get": []}], {"none": []}])
                call(db, "log_api_call", [endpoint, {"none": []}, {"get": []}, "/to-purge", 200, 1, {"none": []}, {"none": []}])
                call(db, "set_schema_parent", [210, {"none": []}])
                call(db, "delete_page_subtree", [200])
                call(db, "purge_page", [200])
                assert sql(db, "SELECT * FROM api_endpoint WHERE database_page_id = 200") == []
                for table in ["api_endpoint_key", "api_field_mapping", "api_call_log"]:
                    assert sql(db, f"SELECT * FROM {table} WHERE endpoint_id = {endpoint}") == [], table
                assert len(sql(db, "SELECT * FROM api_endpoint WHERE database_page_id = 210")) == 1
                print("PASS: database purge removes dependent endpoint keys/mappings/logs and preserves unrelated endpoints", flush=True)
                job = {"scheduled_id": 0, "scheduled_at": {"Interval": {"__time_duration_micros__": 86400000000}}}
                error = call(db, "run_trash_purge_tick", [job], fail=True)
                assert "scheduler" in error, error
                print("PASS: direct retention reducer calls rejected", flush=True)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)


if __name__ == "__main__":
    main()
