#!/usr/bin/env python3
"""Isolated SpacetimeDB 2.0.3 upgrade/lifecycle/security regression checks.

Uses disposable data, identities and fake HTTP credentials; never touches the
running workspace. Set TEST_SPACETIME_BIN_DIR if the pinned CLI lives elsewhere.
"""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
from regression_config import BASELINES, BIN, MODULE_WASM
SECRET = "regression-only-original-key"


class Provider(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.received.append(self.headers.get("Authorization"))
        body = json.dumps({"items": [{"id": "A", "name": "Record", "count": 111}]}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def main():
    providers = [ThreadingHTTPServer(("127.0.0.1", 0), Provider) for _ in range(2)]
    for provider in providers:
        provider.received = []
        threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="selfbase-source-regressions-") as directory:
            temp = Path(directory)
            env = dict(os.environ, XDG_CONFIG_HOME=str(temp / "config"))
            for command in [
                ["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", str(temp / "private.pem")],
                ["openssl", "ec", "-in", str(temp / "private.pem"), "-pubout", "-out", str(temp / "public.pem")],
            ]:
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            with (temp / "server.log").open("w+") as log:
                server = subprocess.Popen([
                    str(BIN / "spacetimedb-standalone"), "start", "--data-dir", str(temp / "data"),
                    "--listen-addr", f"127.0.0.1:{port}", "--non-interactive", "--page_pool_max_size", "67108864",
                    "--jwt-priv-key-path", str(temp / "private.pem"), "--jwt-pub-key-path", str(temp / "public.pem"),
                ], stdout=log, stderr=log)
                try:
                    for _ in range(120):
                        assert server.poll() is None, "Disposable server exited"
                        try:
                            urllib.request.urlopen(base + "/v1/ping", timeout=1).close()
                            break
                        except OSError:
                            time.sleep(.1)
                    else:
                        raise AssertionError("Disposable server startup timed out")

                    def publish(path):
                        result = subprocess.run([
                            str(BIN / "spacetimedb-cli"), "publish", "--server", base, "--yes", "--no-config",
                            "--break-clients", "--bin-path", str(path), "source-regressions",
                        ], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                        assert result.returncode == 0, result.stdout

                    old = temp / "previous.wasm"
                    old.write_bytes(subprocess.check_output(["git", "show", f"{BASELINES['external_sources']}:server/docker/server.wasm"], cwd=ROOT))
                    publish(old)
                    token = re.search(r"eyJ[A-Za-z0-9_.-]+", (temp / "config/spacetime/cli.toml").read_text()).group()

                    def request(path, body, *, sql=False, credential=token, fail=False):
                        req = urllib.request.Request(base + "/v1/database/source-regressions/" + path,
                            data=body.encode() if sql else json.dumps(body).encode(),
                            headers={"Authorization": "Bearer " + credential, "Content-Type": "text/plain" if sql else "application/json"})
                        try:
                            raw = urllib.request.urlopen(req, timeout=30).read().decode()
                            assert not fail, "Expected rejection: " + path
                            return json.loads(raw) if sql else raw
                        except urllib.error.HTTPError as error:
                            message = error.read().decode()
                            if fail:
                                return message
                            raise AssertionError(f"{path}: HTTP {error.code}: {message}") from error

                    def call(name, args, **kwargs):
                        return request("call/" + name, args, **kwargs)

                    def sql(query):
                        result = request("sql", query, sql=True)[0]
                        columns = [column["name"]["some"] for column in result["schema"]["elements"]]
                        return [dict(zip(columns, row)) for row in result["rows"]]

                    def source(database):
                        raw = sql(f"SELECT config FROM database_schema WHERE page_id = {database}")[0]["config"]
                        return json.loads(raw["some"] if isinstance(raw, dict) else raw[1])["externalSource"]

                    def create_database(title):
                        call("create_page", [{"none": []}, {"database": []}, title])
                        database = sql(f"SELECT id FROM page WHERE title = '{title}'")[0]["id"]
                        call("create_database_schema", [database, title])
                        schema = sql(f"SELECT id FROM database_schema WHERE page_id = {database}")[0]["id"]
                        return database, schema

                    database, schema = create_database("Regression")
                    for name, kind in [("Count", "number"), ("Notes", "text")]:
                        call("add_property", [schema, name, {kind: []}, "{}"])
                    props = {p["name"]: p["id"] for p in sql("SELECT id, name FROM property_definition")}
                    call("create_page", [{"some": database}, {"doc": []}, "Row"])
                    row = sql("SELECT id FROM page WHERE title = 'Row'")[0]["id"]
                    call("set_property_value", [row, props["Notes"], {"text": "Personal note"}])
                    config = dict(enabled=True, name="Regression", baseUrl=f"http://127.0.0.1:{providers[0].server_port}",
                        searchPath="/search", queryParam="q", resultsPath="items", detailPath="/items/{id}", detailResultPath="",
                        idPath="id", labelPath="name", subtitlePath="", imagePath="", authHeader="Authorization", authPrefix="Bearer ",
                        linkPropertyId="", mappings=[dict(sourcePath="count", targetPropertyId=str(props["Count"]), targetType="Number", transform="identity")],
                        syncIntervalSeconds=60, fillEmptyTitle=False, revision="")
                    call("configure_external_source", [database, json.dumps(config), {"some": SECRET}])
                    config = source(database)
                    link_id = int(config["linkPropertyId"])
                    call("link_external_record", [row, "A", "A"])
                    # Simulate a definition removed by the unprotected old reducer.
                    call("delete_property", [link_id])
                    orphan, _ = create_database("Orphan")
                    orphan_config = dict(config, linkPropertyId="", mappings=[])
                    call("configure_external_source", [orphan, json.dumps(orphan_config), {"some": SECRET}])
                    call("delete_page_subtree", [orphan])
                    call("purge_page", [orphan])
                    assert len(sql("SELECT database_id FROM external_source_secret")) == 2
                    cells = sql("SELECT * FROM page_property_value")
                    publish(MODULE_WASM)
                    call("run_pending_migrations", [])
                    call("run_pending_migrations", [])
                    assert sql("SELECT * FROM page_property_value") == cells
                    assert len(sql("SELECT database_id FROM external_source_secret")) == 1
                    scope = sql("SELECT scope FROM external_source_secret")[0]["scope"]
                    assert SECRET not in json.dumps(scope) and scope != {"none": []}
                    call("configure_external_source", [database, json.dumps(config), {"none": []}])
                    config = source(database)
                    assert int(config["linkPropertyId"]) == link_id
                    assert sql(f"SELECT config FROM property_definition WHERE id = {link_id}")[0]["config"] == '{"externalSource":true}'
                    for reducer, args in [("delete_property", [link_id]), ("update_property_type", [link_id, {"number": []}])]:
                        assert "Disconnect" in call(reducer, args, fail=True)
                    call("update_property_config", [link_id, "{}"])
                    assert "externalSource" in sql(f"SELECT config FROM property_definition WHERE id = {link_id}")[0]["config"]
                    print("PASS: in-place upgrade scopes legacy credentials, removes orphan keys and repairs/protects the original link column", flush=True)

                    def apply(record, count):
                        fields = [] if count is None else [dict(propertyId=str(props["Count"]), kind="Number", value=count)]
                        call("apply_external_record", [row, json.dumps(config), record, record, json.dumps(fields)])

                    call("delete_page", [database])
                    assert "Database is deleted" in call("apply_external_record", [row, json.dumps(config), "A", "A", "[]"], fail=True)
                    call("restore_page", [database])
                    apply("A", 111)
                    call("link_external_record", [row, "", ""])
                    call("link_external_record", [row, "B", "B"])
                    apply("B", None)
                    assert not sql(f"SELECT value FROM page_property_value WHERE page_id = {row} AND property_definition_id = {props['Count']}")
                    apply("B", 222)
                    call("link_external_record", [row, "C", "C"])
                    assert not any(h["is_current"] for h in sql(f"SELECT is_current FROM page_property_value_history WHERE page_id = {row} AND property_definition_id = {props['Count']}"))
                    apply("C", 333)
                    raw_link = sql(f"SELECT value FROM page_property_value WHERE page_id = {row} AND property_definition_id = {link_id}")[0]["value"]
                    assert json.loads(raw_link[1])["syncedRevision"] == config["revision"]
                    assert "Personal note" in json.dumps(sql("SELECT value FROM page_property_value"))
                    enriched = dict(config, imagePath="activity.cover", enrichments=[dict(path="/activity", resultsPath="items", recordMatchPath="id", matchPath="id", targetField="activity")])
                    call("configure_external_source", [database, json.dumps(enriched), {"none": []}])
                    call("delete_page", [row])
                    call("disconnect_external_source", [database, ""])
                    assert not sql(f"SELECT id FROM property_definition WHERE id = {link_id}")
                    assert "333" in json.dumps(sql("SELECT value FROM page_property_value"))
                    call("restore_page", [row])
                    call("configure_external_source", [database, json.dumps(dict(config, linkPropertyId="")), {"some": SECRET}])
                    assert len(sql("SELECT id FROM property_definition")) == 3
                    print("PASS: unlink/relink clears stale data; history is retired; successful links are marked; enriched images save; trash disconnect keeps values without hidden columns", flush=True)

                    stale_config = source(database)
                    call("delete_property", [props["Count"]])
                    assert source(database)["mappings"] == []
                    assert "configuration changed" in call("apply_external_record", [row, json.dumps(stale_config), "C", "C", "[]"], fail=True)
                    print("PASS: deleting a mapped column removes stale source mappings", flush=True)

                    call("register", ["admin@example.test", "Admin", "regression-password-long"])
                    call("create_local_user", ["member@example.test", "Member", "regression-password-long"])
                    identity = json.load(urllib.request.urlopen(urllib.request.Request(base + "/v1/identity", data=b"")))
                    member = identity["token"]
                    call("login", ["member@example.test", "regression-password-long"], credential=member)
                    shared = dict(config, linkPropertyId="", mappings=[])
                    call("save_shared_external_source", ["restore-check", json.dumps(shared), {"some": SECRET}, {"none": []}])
                    call("delete_page_subtree", [database])
                    call("purge_page", [database])
                    assert not sql("SELECT id FROM page")
                    assert not sql("SELECT database_id FROM external_source_secret")
                    assert "admins" in call("import_v_2_begin", [json.dumps({"format": "selfbase-snapshot-v2"})], credential=member, fail=True)
                    assert len(sql("SELECT source_id FROM shared_external_source_secret")) == 1
                    config = dict(config, mappings=[])
                    config["baseUrl"] = f"http://127.0.0.1:{providers[1].server_port}"
                    timestamp = {"__selfbase": "timestamp", "v": "1"}
                    page = dict(id=database, pageType={"tag": "Database"}, title="Restored", sortOrder=0, createdBy={"tag": "Human"}, createdAt=timestamp, updatedAt=timestamp)
                    restored_schema = dict(id=schema, pageId=database, name="Restored", config=json.dumps({"externalSource": config}))
                    call("import_v_2_begin", [json.dumps({"format": "selfbase-snapshot-v2"})])
                    assert not sql("SELECT source_id FROM shared_external_source_secret")
                    call("import_v_2_chunk", [1, "page", json.dumps([page])])
                    call("import_v_2_chunk", [2, "database_schema", json.dumps([restored_schema])])
                    manifest_counts = dict.fromkeys(json.loads((ROOT / "server/spacetimedb/snapshot_tables_v2.json").read_text())["include"], 0)
                    manifest_counts.update(page=1, database_schema=1)
                    call("import_v_2_commit", [json.dumps({"counts": manifest_counts})])
                    probe_env = dict(os.environ, SELFBASE_STDB_URL=base, SELFBASE_STDB_DB_NAME="source-regressions", SELFBASE_STDB_TOKEN=token, TEST_DATABASE_ID=str(database))
                    probe = "import {serviceTransport,loadSource,searchSource} from './web/src/lib/external-sources/server'; async function main(){await searchSource(await loadSource(serviceTransport(),process.env.TEST_DATABASE_ID!), '');} main().catch(()=>{process.exitCode=1});"
                    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", probe], cwd=ROOT, env=probe_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    assert result.returncode != 0 and providers[1].received == []
                    assert "credential" in call("configure_external_source", [database, json.dumps(config), {"none": []}], fail=True)
                    call("configure_external_source", [database, json.dumps(config), {"some": "regression-only-new-key"}])
                    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", probe], cwd=ROOT, env=probe_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    assert result.returncode == 0 and providers[1].received == ["Bearer regression-only-new-key"]
                    print("PASS: purge removes private credentials; members cannot import; restore clears credentials and cannot forward an old key to another origin; re-entering a new key restores access", flush=True)
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()
    finally:
        for provider in providers:
            provider.shutdown()
            provider.server_close()


if __name__ == "__main__":
    main()
