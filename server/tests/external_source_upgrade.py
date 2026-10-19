#!/usr/bin/env python3
"""Local-only end-to-end check: old module -> current module -> generic HTTP source."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
BIN = Path.home() / '.local/share/spacetime/bin/2.0.3'
CLI = str(BIN / 'spacetimedb-cli')
SECRET = 'integration-test-secret'


class Provider(BaseHTTPRequestHandler):
    activity_error = 0
    seconds = 288180
    stock = 9
    requests = []
    complete = False
    progress = 50
    dates = ["2026-01-01T00:00:00Z", None, "2026-03-01T00:00:00Z"]


    def do_GET(self):
        Provider.requests.append(self.path)
        if self.headers.get('Authorization') != 'Bearer ' + SECRET:
            self.send_response(401)
            self.end_headers()
            return
        if self.path.startswith('/activity'):
            if Provider.activity_error:
                self.send_response(Provider.activity_error); self.end_headers(); return
            payload = {'events': [{'appid': '1', 'first': 1704067200}, {'appid': 'other', 'first': 0}]}
            data = json.dumps(payload).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
            return
        if self.path.startswith('/catalog'):
            payload = {'response': {'games': [{'appid': 1, 'name': 'Catalog game', 'art': {'hash':'abc'}, 'playtime_forever': 120, 'rtime_last_played': 1767225600}, {'appid': 'item-1', 'name': 'Same ID other provider', 'playtime_forever': 42, 'rtime_last_played': 0}]}}
            data = json.dumps(payload).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
            return
        if '/events?' in self.path:
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            offset = int(params.get('offset', ['0'])[0])
            limit = int(params.get('limit', ['2'])[0])
            payload = {'entries': [{'seenAt': d} for d in Provider.dates[offset:offset+limit]], 'total': len(Provider.dates)}
            data = json.dumps(payload).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
            return
        row = {'sku': 'item-1', 'display': {'title': 'Desk lamp'}, 'elapsed': Provider.seconds, 'stock': Provider.stock,
               'cover_url': 'https://images.example.com/direct.jpg', 'kind': 'collection', 'state': {'complete': Provider.complete, 'progress': Provider.progress}}
        payload = {'data': {'items': [row]}} if self.path.startswith('/lookup?') else row
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


def execute(args, env=None):
    p = subprocess.run([str(a) for a in args], env=env, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert p.returncode == 0, p.stdout
    return p.stdout


def main():
    with tempfile.TemporaryDirectory(prefix='selfbase-source-e2e-') as temp:
        temp = Path(temp)
        env = dict(os.environ, XDG_CONFIG_HOME=str(temp / 'config'))
        execute(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', temp / 'private.pem'])
        execute(['openssl', 'ec', '-in', temp / 'private.pem', '-pubout', '-out', temp / 'public.pem'])
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        url = f'http://127.0.0.1:{port}'
        provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        log = (temp / 'server.log').open('w+')
        server = subprocess.Popen([str(BIN / 'spacetimedb-standalone'), 'start', '--data-dir', str(temp / 'data'),
            '--listen-addr', f'127.0.0.1:{port}', '--non-interactive', '--page_pool_max_size', '67108864',
            '--jwt-priv-key-path', str(temp / 'private.pem'), '--jwt-pub-key-path', str(temp / 'public.pem')], stdout=log, stderr=log)
        try:
            for _ in range(120):
                assert server.poll() is None
                try:
                    urllib.request.urlopen(url + '/v1/ping', timeout=1).close()
                    break
                except OSError:
                    time.sleep(.25)
            else:
                raise AssertionError('Startup timed out')
            old = temp / 'old.wasm'
            old.write_bytes(subprocess.check_output(['git', 'show', '4f41514:server/docker/server.wasm'], cwd=ROOT))
            db = 'external-source-check'
            def publish(wasm):
                execute([CLI, 'publish', '--server', url, '--yes', '--no-config', '--break-clients', '--bin-path', wasm, db], env)
                execute([CLI, 'call', '--server', url, '--yes', db, 'run_pending_migrations'], env)
            publish(old)
            config_text = (temp / 'config/spacetime/cli.toml').read_text()
            token = re.search(r'eyJ[A-Za-z0-9_.-]+', config_text).group()
            def request(path, body, token_override=None, sql=False, fail=False):
                req = urllib.request.Request(url + '/v1/database/' + db + '/' + path,
                    data=(body.encode() if sql else json.dumps(body).encode()),
                    headers={'Authorization': 'Bearer ' + (token_override or token),
                             'Content-Type': 'text/plain' if sql else 'application/json'})
                try:
                    with urllib.request.urlopen(req, timeout=20) as response:
                        raw = response.read().decode()
                        assert not fail, 'Expected rejection'
                        return json.loads(raw) if sql else raw
                except urllib.error.HTTPError as error:
                    text = error.read().decode()
                    if fail:
                        return text
                    raise AssertionError(f'{path}: {error.code} {text}')
            def call(reducer, args, **kwargs):
                return request('call/' + reducer, args, **kwargs)
            def sql(query, token_override=None, fail=False):
                data = request('sql', query, token_override, sql=True, fail=fail)
                if fail:
                    return data
                columns = [el['name']['some'] for el in data[0]['schema']['elements']]
                return [dict(zip(columns, row)) for row in data[0]['rows']]
            call('create_page', [{'none': []}, {'database': []}, 'Inventory'])
            database_id = sql("SELECT id FROM page WHERE title = 'Inventory'")[0]['id']
            call('create_database_schema', [database_id, 'Inventory'])
            schema_id = sql('SELECT id FROM database_schema')[0]['id']
            call('create_page', [{'some': database_id}, {'doc': []}, 'Untitled'])
            row_id = sql("SELECT id FROM page WHERE title = 'Untitled'")[0]['id']
            for name, kind in [('Notes', 'Text'), ('Elapsed', 'Duration'), ('Stock', 'Number')]:
                call('add_property', [schema_id, name, {kind.lower(): []}, '{}'])
            properties = {p['name']: p['id'] for p in sql('SELECT id, name FROM property_definition')}
            call('set_property_value', [row_id, properties['Notes'], {'text': 'Keep this personal note'}])
            before = sql('SELECT * FROM page_property_value')
            if os.environ.get('SHARED_SOURCE_CHECK') == '1':
                previous = temp / 'previous.wasm'
                previous.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:server/docker/server.wasm'], cwd=ROOT))
                publish(previous)
            else:
                publish(ROOT / 'server/docker/server.wasm')
            assert sql('SELECT * FROM page_property_value') == before
            print('PASS: existing database upgraded without altering old records', flush=True)
            config = {
                'enabled': True, 'name': 'Inventory service', 'baseUrl': f'http://127.0.0.1:{provider.server_port}',
                'searchPath': '/lookup', 'queryParam': 'search', 'resultsPath': 'data.items',
                'detailPath': '/item/{id}', 'detailResultPath': '', 'idPath': 'sku', 'labelPath': 'display.title',
                'subtitlePath': '', 'imagePath': 'cover_url', 'authHeader': 'Authorization', 'authPrefix': 'Bearer ',
                'linkPropertyId': '', 'mappings': [
                    {'sourcePath': 'elapsed', 'targetPropertyId': str(properties['Elapsed']), 'targetType': 'Duration', 'transform': 'secondsToMinutes'},
                    {'sourcePath': 'stock', 'targetPropertyId': str(properties['Stock']), 'targetType': 'Number', 'transform': 'identity'},
                ], 'syncIntervalSeconds': 60, 'fillEmptyTitle': True, 'revision': '',
            }
            call('configure_external_source', [database_id, json.dumps(config), {'some': SECRET}])
            raw_config = sql('SELECT config FROM database_schema')[0]['config']
            raw_config = raw_config['some'] if isinstance(raw_config, dict) else raw_config[1]
            config = json.loads(raw_config)['externalSource']
            assert SECRET not in raw_config
            call('link_external_record', [row_id, 'item-1', 'Old label'])
            if os.environ.get('SHARED_SOURCE_CHECK') == '1':
                old_cells = sql('SELECT * FROM page_property_value')
                old_settings = sql('SELECT * FROM database_schema')
                publish(ROOT / 'server/docker/server.wasm')
                assert sql('SELECT * FROM page_property_value') == old_cells
                assert sql('SELECT * FROM database_schema') == old_settings
                print('PASS: upgrade from deployed legacy-source WASM preserves configuration, credentials and linked records', flush=True)
            node_env = dict(os.environ, SELFBASE_STDB_URL=url, SELFBASE_STDB_DB_NAME=db,
                            SELFBASE_STDB_TOKEN=token, TEST_DATABASE_ID=str(database_id), TEST_ROW_ID=str(row_id))
            def run_worker():
                print(execute([ROOT / 'web/node_modules/.bin/tsx', ROOT / 'server/tests/external_source_smoke.ts'], node_env), end='', flush=True)
            run_worker()
            values = sql('SELECT property_definition_id, value FROM page_property_value')
            assert any(v['value'] == [11, 4803] or v['value'] == {'Duration': 4803} for v in values), values
            assert 'Keep this personal note' in json.dumps(values)
            assert sql(f'SELECT title FROM page WHERE id = {row_id}')[0]['title'] == 'Desk lamp'
            history = sql('SELECT * FROM page_property_value_history')
            run_worker()
            assert sql('SELECT * FROM page_property_value_history') == history, 'Unchanged data generated extra history'
            Provider.seconds = None
            Provider.stock = 0
            run_worker()
            values = sql('SELECT property_definition_id, value FROM page_property_value')
            assert '4803' in json.dumps(values), 'Missing duration erased known data'
            print('PASS: units, null preservation, zero values, user notes and idempotent history', flush=True)
            expected = json.dumps(config)
            call('link_external_record', [row_id, 'item-2', 'Other record'])
            unchanged = sql('SELECT * FROM page_property_value')
            assert all(str(cell['property_definition_id']) not in (str(properties['Elapsed']), str(properties['Stock']))
                       for cell in unchanged), 'Rebinding retained another record statistics'
            error = call('apply_external_record', [row_id, expected, 'item-1', 'Late response', '[]'], fail=True)
            assert 'link changed' in error, error
            assert sql('SELECT * FROM page_property_value') == unchanged
            call('link_external_record', [row_id, 'item-1', 'Desk lamp'])
            call('configure_external_source', [database_id, expected, {'none': []}])
            error = call('apply_external_record', [row_id, expected, 'item-1', 'Late response', '[]'], fail=True)
            assert 'configuration changed' in error, error
            current_config = sql('SELECT config FROM database_schema')[0]['config']
            current_config = json.loads(current_config['some'] if isinstance(current_config, dict) else current_config[1])['externalSource']
            unchanged = sql('SELECT * FROM page_property_value')
            invalid_fields = [
                {'propertyId': str(properties['Elapsed']), 'kind': 'Duration', 'value': '999'},
                {'propertyId': str(properties['Stock']), 'kind': 'Number', 'value': 'not-a-number'},
            ]
            call('apply_external_record', [row_id, json.dumps(current_config), 'item-1', 'Desk lamp', json.dumps(invalid_fields)], fail=True)
            assert sql('SELECT * FROM page_property_value') == unchanged, 'Partially applied failed snapshot'
            print('PASS: stale link/config writes and partial invalid snapshots rejected transactionally', flush=True)
            # A separate native account is authenticated but has no admin role.
            call('register', ['admin@example.test', 'Admin', 'test-password-long-enough'])
            call('create_local_user', ['member@example.test', 'Member', 'test-password-long-enough'])
            identity_req = urllib.request.Request(url + '/v1/identity', data=b'')
            identity_data = json.load(urllib.request.urlopen(identity_req))
            member_token = identity_data['token']
            call('login', ['member@example.test', 'test-password-long-enough'], token_override=member_token)
            assert 'Only a workspace admin' in call('configure_external_source', [database_id, expected, {'none': []}], token_override=member_token, fail=True)
            assert 'configure_external_source' in call('update_database_schema_config', [schema_id, '{}'], token_override=member_token, fail=True)
            assert 'integration-test-secret' not in sql('SELECT * FROM external_source_secret', token_override=member_token, fail=True)
            print('PASS: credentials private; authenticated non-admin cannot configure networking or bypass the guard', flush=True)
            # Exercise the shipped Next.js API and instrumentation worker too.
            with socket.socket() as web_socket:
                web_socket.bind(('127.0.0.1', 0))
                web_port = web_socket.getsockname()[1]
            Provider.stock = 13
            web_env = dict(node_env, PORT=str(web_port), HOSTNAME='127.0.0.1', EXTERNAL_SOURCE_SYNC_ENABLED='true')
            if os.environ.get('SOURCE_TITLE_BROWSER') == '1':
                standalone = ROOT / 'web/.next/standalone/web'
                shutil.copytree(ROOT / 'web/.next/static', standalone / '.next/static', dirs_exist_ok=True)
                shutil.copytree(ROOT / 'web/public', standalone / 'public', dirs_exist_ok=True)
            web_log = (temp / 'web.log').open('w+')
            web = subprocess.Popen(['node', str(ROOT / 'web/.next/standalone/web/server.js')], env=web_env,
                                   cwd=ROOT / 'web/.next/standalone/web', stdout=web_log, stderr=web_log)
            web_url = f'http://127.0.0.1:{web_port}/api/integrations/external-source?db={db}&databaseId={database_id}'
            try:
                for _ in range(120):
                    assert web.poll() is None, 'Production web server exited'
                    try:
                        urllib.request.urlopen(web_url, timeout=1)
                    except urllib.error.HTTPError as error:
                        assert error.code == 403
                        break
                    except OSError:
                        time.sleep(.25)
                else:
                    raise AssertionError('Production server startup timed out')
                search_request = urllib.request.Request(web_url + '&q=lamp', headers={'Authorization': 'Bearer ' + token})
                records = json.load(urllib.request.urlopen(search_request))
                assert records['records'][0]['id'] == 'item-1', records
                assert SECRET not in json.dumps(records)
                for _ in range(80):
                    rows = sql(f"SELECT value FROM page_property_value WHERE page_id = {row_id} AND property_definition_id = {properties['Stock']}")
                    if rows and (rows[0]['value'] == [1, 13.0] or rows[0]['value'] == {'number': 13.0}):
                        break
                    time.sleep(.25)
                else:
                    raise AssertionError('Instrumentation did not refresh the row in the background')
                status_req = urllib.request.Request(web_url + '&status=1', headers={'Authorization': 'Bearer ' + token})
                status = json.load(urllib.request.urlopen(status_req))
                assert status['lastRun'] and status['updated'] == 1 and status['error'] is None, status
                Provider.stock = 17
                refresh_req = urllib.request.Request(web_url + f'&rowId={row_id}', data=b'', headers={'Authorization': 'Bearer ' + token})
                assert json.load(urllib.request.urlopen(refresh_req))['record']['id'] == 'item-1'
                print('PASS: production API authorization, private server-side proxy, manual refresh and automatic refresh with no browser', flush=True)
                if os.environ.get('SOURCE_TITLE_BROWSER') == '1':
                    Provider.seconds = 288180
                    call('create_page', [{'some': database_id}, {'doc': []}, 'Untitled'])
                    call('create_page', [{'some': database_id}, {'doc': []}, 'My custom title'])
                    browser_env = dict(node_env, TEST_WEB_ORIGIN=f'http://127.0.0.1:{web_port}')
                    print(execute(['node', ROOT / 'server/tests/source_title_browser.cjs'], browser_env), end='', flush=True)
            except BaseException:
                web_log.flush(); web_log.seek(0); print(web_log.read()[-5000:])
                raise
            finally:
                web.terminate()
                try: web.wait(timeout=10)
                except subprocess.TimeoutExpired: web.kill(); web.wait()
                web_log.close()
            raw_config = sql('SELECT config FROM database_schema')[0]['config']
            active = json.loads(raw_config['some'] if isinstance(raw_config, dict) else raw_config[1])['externalSource']
            changed_url = dict(active, baseUrl='http://another-service:8080')
            assert 'Re-enter the credential' in call('configure_external_source', [database_id, json.dumps(changed_url), {'none': []}], fail=True)
            assert sql('SELECT config FROM database_schema')[0]['config'] == raw_config
            active['enabled'] = False
            call('configure_external_source', [database_id, json.dumps(active), {'none': []}])
            before_unlink = {cell['property_definition_id']: cell['value'] for cell in sql('SELECT property_definition_id, value FROM page_property_value') if str(cell['property_definition_id']) != active['linkPropertyId']}
            call('link_external_record', [row_id, '', ''])
            after_unlink = {cell['property_definition_id']: cell['value'] for cell in sql('SELECT property_definition_id, value FROM page_property_value') if str(cell['property_definition_id']) != active['linkPropertyId']}
            assert before_unlink == after_unlink
            print('PASS: rebind clears old mapped statistics; disabled source permits unlink; credentials not reused for changed URL', flush=True)
            if os.environ.get('SHARED_SOURCE_CHECK') == '1':
                def source_config(database):
                    raw = sql(f'SELECT config FROM database_schema WHERE page_id = {database}')[0]['config']
                    return json.loads(raw['some'] if isinstance(raw, dict) else raw[1])['externalSource']
                active = source_config(database_id)
                active['enabled'] = True
                call('configure_external_source', [database_id, json.dumps(active), {'none': []}])
                call('link_external_record', [row_id, 'item-1', 'Desk lamp'])
                active = source_config(database_id)
                cells_before = sql('SELECT * FROM page_property_value')
                call('save_shared_external_source', ['inventory', json.dumps(active), {'none': []}, {'some': database_id}])
                shared = json.loads(sql("SELECT value_json FROM workspace_setting WHERE key = 'external-source.inventory'")[0]['value_json'])
                promoted = source_config(database_id)
                assert promoted['sourceId'] == 'inventory'
                assert promoted['linkPropertyId'] == active['linkPropertyId'] and promoted['mappings'] == active['mappings']
                assert sql('SELECT * FROM page_property_value') == cells_before
                assert sql('SELECT * FROM external_source_secret') == []
                assert len(sql('SELECT * FROM shared_external_source_secret')) == 1
                assert SECRET not in json.dumps(sql('SELECT * FROM workspace_setting'))
                print('PASS: legacy connection promoted atomically; private credential moved once; all links, mappings and values preserved', flush=True)
                assert 'Only a workspace admin' in call('save_shared_external_source', ['forbidden', json.dumps(shared), {'some': SECRET}, {'none': []}], token_override=member_token, fail=True)
                assert SECRET not in sql('SELECT * FROM shared_external_source_secret', token_override=member_token, fail=True)
                assert 'Data sources' in call('set_workspace_setting', ['external-source.inventory', '{}'], fail=True)
                assert 'still connected' in call('delete_shared_external_source', ['inventory'], fail=True)
                changed_shared = dict(shared, baseUrl='http://another-service:8080')
                assert 'Re-enter the credential' in call('save_shared_external_source', ['inventory', json.dumps(changed_shared), {'none': []}, {'none': []}], fail=True)
                assert source_config(database_id) == promoted
                call('create_page', [{'none': []}, {'database': []}, 'Second inventory'])
                second_db = sql("SELECT id FROM page WHERE title = 'Second inventory'")[0]['id']
                call('create_database_schema', [second_db, 'Second inventory'])
                second_schema = sql(f'SELECT id FROM database_schema WHERE page_id = {second_db}')[0]['id']
                call('add_property', [second_schema, 'Elapsed', {'duration': []}, '{}'])
                elapsed_id = sql(f'SELECT id FROM property_definition WHERE schema_id = {second_schema}')[0]['id']
                binding = dict(shared, enabled=True, mappings=[dict(active['mappings'][0], targetPropertyId=str(elapsed_id))])
                call('configure_external_source', [second_db, json.dumps(binding), {'none': []}])
                call('create_page', [{'some': second_db}, {'doc': []}, 'Untitled'])
                second_row = sql(f'SELECT id FROM page WHERE parent_pk = {second_db}')[0]['id']
                call('link_external_record', [second_row, 'item-1', 'Desk lamp'])
                Provider.seconds = 288180
                print(execute([ROOT / 'web/node_modules/.bin/tsx', ROOT / 'server/tests/external_source_smoke.ts'], node_env), end='', flush=True)
                second_env = dict(node_env, TEST_DATABASE_ID=str(second_db), TEST_ROW_ID=str(second_row))
                print(execute([ROOT / 'web/node_modules/.bin/tsx', ROOT / 'server/tests/external_source_smoke.ts'], second_env), end='', flush=True)
                assert len(sql('SELECT * FROM shared_external_source_secret')) == 1
                assert sql('SELECT * FROM external_source_secret') == []
                stale = source_config(second_db)
                updated_shared = dict(shared, name='Updated inventory')
                call('save_shared_external_source', ['inventory', json.dumps(updated_shared), {'none': []}, {'none': []}])
                assert source_config(database_id)['name'] == 'Updated inventory'
                assert source_config(second_db)['name'] == 'Updated inventory'
                assert source_config(second_db)['mappings'] == stale['mappings']
                assert 'configuration changed' in call('apply_external_record', [second_row, json.dumps(stale), 'item-1', 'Desk lamp', '[]'], fail=True)
                print('PASS: two databases reuse one private key; shared edits propagate; per-database mappings and stale-write protection retained', flush=True)
                if os.environ.get('SHARED_SOURCE_BROWSER') == '1':
                    call('create_page', [{'none': []}, {'database': []}, 'Browser inventory'])
                    third_db = sql("SELECT id FROM page WHERE title = 'Browser inventory'")[0]['id']
                    call('create_database_schema', [third_db, 'Browser inventory'])
                    third_schema = sql(f'SELECT id FROM database_schema WHERE page_id = {third_db}')[0]['id']
                    for title, kind in [('Elapsed', 'duration'), ('Stock', 'number')]:
                        call('add_property', [third_schema, title, {kind: []}, '{}'])
                    call('create_page', [{'some': third_db}, {'doc': []}, 'Untitled'])
                    standalone = ROOT / 'web/.next/standalone/web'
                    shutil.copytree(ROOT / 'web/.next/static', standalone / '.next/static', dirs_exist_ok=True)
                    shutil.copytree(ROOT / 'web/public', standalone / 'public', dirs_exist_ok=True)
                    web_log = (temp / 'shared-web.log').open('w+')
                    web = subprocess.Popen(['node', str(standalone / 'server.js')], env=web_env, cwd=standalone, stdout=web_log, stderr=web_log)
                    try:
                        time.sleep(2)
                        browser_env = dict(node_env, TEST_WEB_ORIGIN=f'http://127.0.0.1:{web_port}', TEST_SECOND_DATABASE_ID=str(second_db), TEST_THIRD_DATABASE_ID=str(third_db))
                        print(execute(['node', ROOT / 'server/tests/shared_sources_browser.cjs'], browser_env), end='', flush=True)
                    except BaseException:
                        web_log.flush(); web_log.seek(0); print(web_log.read()[-5000:])
                        raise
                    finally:
                        web.terminate()
                        try: web.wait(timeout=10)
                        except subprocess.TimeoutExpired: web.kill(); web.wait()
                        web_log.close()
            if os.environ.get('RULES_SOURCE_CHECK') == '1':
                def current_config():
                    raw = sql(f'SELECT config FROM database_schema WHERE page_id = {database_id}')[0]['config']
                    return json.loads(raw['some'] if isinstance(raw, dict) else raw[1])['externalSource']
                active = current_config()
                active['enabled'] = True
                call('add_property', [schema_id, 'State', {'checkbox': []}, '{}'])
                call('add_property', [schema_id, 'Last event', {'date': []}, '{}'])
                extra = {p['name']: p['id'] for p in sql(f'SELECT id, name FROM property_definition WHERE schema_id = {schema_id}')}
                call('set_property_value', [row_id, extra['State'], {'checkbox': False}])
                call('update_property_type', [extra['State'], {'select': []}])
                status_mapping = {'sourcePath': 'state', 'targetPropertyId': str(extra['State']), 'targetType': 'Select', 'transform': 'statusRules',
                    'rules': [{'path': 'state.complete', 'operator': 'equals', 'value': 'true', 'result': 'Done'},
                              {'path': 'state.progress', 'operator': 'greaterThan', 'value': '0', 'result': 'Active'}],
                    'defaultValue': 'Not started', 'preserveValues': ['Paused']}
                related = {'path': '/item/{id}/events', 'resultsPath': 'entries', 'valuePath': 'seenAt', 'whenPath': 'kind', 'whenEquals': 'collection',
                           'offsetParam': 'offset', 'limitParam': 'limit', 'totalPath': 'total', 'pageSize': 2}
                active['mappings'].extend([status_mapping, {'sourcePath': 'state.lastSeen', 'targetPropertyId': str(extra['Last event']),
                                                           'targetType': 'Date', 'transform': 'isoDateToMillis', 'related': related}])
                call('configure_external_source', [database_id, json.dumps(active), {'none': []}])
                call('link_external_record', [row_id, 'item-1', 'Desk lamp'])
                def sync():
                    execute([ROOT / 'web/node_modules/.bin/tsx', ROOT / 'server/tests/external_source_smoke.ts'], node_env)
                def raw_value(prop):
                    return sql(f"SELECT value FROM page_property_value WHERE page_id = {row_id} AND property_definition_id = {extra[prop]}")[0]['value']
                sync()
                assert raw_value('State') == [3, 'Active'], raw_value('State')
                assert str(raw_value('Last event')[1]) == '1772323200000', raw_value('Last event')
                assert 'Paused' in json.loads(sql(f"SELECT config FROM property_definition WHERE id = {extra['State']}")[0]['config'])['options']
                call('set_property_value', [row_id, extra['State'], {'select': 'Paused'}])
                Provider.complete = True
                sync()
                assert raw_value('State') == [3, 'Paused'], raw_value('State')
                call('set_property_value', [row_id, extra['State'], {'select': 'Active'}])
                sync()
                assert raw_value('State') == [3, 'Done']
                Provider.complete = False
                Provider.progress = 0
                Provider.dates = []
                sync()
                assert raw_value('State') == [3, 'Not started']
                assert str(raw_value('Last event')[1]) == '1772323200000'
                stable = sql('SELECT * FROM page_property_value')
                Provider.dates = ['not-a-date']
                result = subprocess.run([str(ROOT / 'web/node_modules/.bin/tsx'), str(ROOT / 'server/tests/external_source_smoke.ts')], env=node_env, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                assert result.returncode != 0 and 'invalid date' in result.stdout, result.stdout
                assert sql('SELECT * FROM page_property_value') == stable
                bad = current_config()
                bad['mappings'][-1]['related']['path'] = '//evil/{id}'
                assert 'same-source path' in call('configure_external_source', [database_id, json.dumps(bad), {'none': []}], fail=True)
                print('PASS: conditional Select states; protected manual status survives worker sync; changing label resumes sync; latest related date spans pages; empty/failed responses preserve data', flush=True)
                if os.environ.get('RULES_SOURCE_BROWSER') == '1':
                    Provider.progress = 50
                    Provider.dates = ["2026-03-01T00:00:00Z"]
                    standalone = ROOT / 'web/.next/standalone/web'
                    shutil.copytree(ROOT / 'web/.next/static', standalone / '.next/static', dirs_exist_ok=True)
                    shutil.copytree(ROOT / 'web/public', standalone / 'public', dirs_exist_ok=True)
                    web_log = (temp / 'rules-web.log').open('w+')
                    web = subprocess.Popen(['node', str(standalone / 'server.js')], env=web_env, cwd=standalone, stdout=web_log, stderr=web_log)
                    try:
                        time.sleep(2)
                        browser_env = dict(node_env, TEST_WEB_ORIGIN=f'http://127.0.0.1:{web_port}')
                        print(execute(['node', ROOT / 'server/tests/source_rules_browser.cjs'], browser_env), end='', flush=True)
                    except BaseException:
                        web_log.flush(); web_log.seek(0); print(web_log.read()[-5000:])
                        raise
                    finally:
                        web.terminate()
                        try: web.wait(timeout=10)
                        except subprocess.TimeoutExpired: web.kill(); web.wait()
                        web_log.close()


            if os.environ.get('MULTI_SOURCE_CHECK') == '1':
                Provider.dates = ["2026-03-01T00:00:00Z"]
                active = source_config(database_id)
                call('add_property', [schema_id, 'First event', {'date': []}, '{}'])
                first_event_id = sql(f"SELECT id FROM property_definition WHERE schema_id = {schema_id} AND name = 'First event'")[0]['id']
                catalog = dict(shared, name='Collection service', sourceId='catalog', recordMode='collection', syncMode='interval',
                    searchPath='/catalog', queryParam='', detailPath='', resultsPath='response.games', idPath='appid', labelPath='name',
                    imageUrlTemplate='https://images.example.com/apps/{appid}/{art.hash}.jpg',
                    enrichments=[{'path':'/activity','resultsPath':'events','recordMatchPath':'appid','matchPath':'appid','targetField':'activity'}],
                    syncIntervalSeconds=21600, mappings=[], linkPropertyId='')
                call('save_shared_external_source', ['catalog', json.dumps(catalog), {'some': SECRET}, {'none': []}])
                catalog = json.loads(sql("SELECT value_json FROM workspace_setting WHERE key = 'external-source.catalog'")[0]['value_json'])
                binding = dict(catalog, enabled=True, linkPropertyId=active['linkPropertyId'], mappings=[
                    {'sourcePath': 'playtime_forever', 'targetPropertyId': str(properties['Elapsed']), 'targetType': 'Duration', 'transform': 'identity'},
                    {'sourcePath':'activity.first','targetPropertyId':str(first_event_id),'targetType':'Date','transform':'unixSecondsToMillis','zeroIsEmpty':True},
                    {'sourcePath': 'rtime_last_played', 'targetPropertyId': str(extra['Last event']), 'targetType': 'Date', 'transform': 'unixSecondsToMillis', 'zeroIsEmpty': True}])
                stable = sql('SELECT * FROM page_property_value')
                call('configure_external_source', [database_id, json.dumps(binding), {'none': []}])
                assert source_config(database_id) == active
                assert sql('SELECT * FROM page_property_value') == stable
                assert 'still connected' in call('delete_shared_external_source', ['catalog'], fail=True)
                updated_catalog = dict(catalog, name='Collection service updated', syncIntervalSeconds=86400)
                call('save_shared_external_source', ['catalog', json.dumps(updated_catalog), {'none': []}, {'none': []}])
                assert source_config(database_id) == active
                raw = sql(f'SELECT config FROM database_schema WHERE page_id = {database_id}')[0]['config']
                all_config = json.loads(raw['some'] if isinstance(raw, dict) else raw[1])
                binding = all_config['externalSources'][0]
                assert binding['name'] == 'Collection service updated' and binding['syncIntervalSeconds'] == 86400
                bypass = dict(all_config, externalSources=[])
                assert 'configure_external_source' in call('update_database_schema_config', [schema_id, json.dumps(bypass)], token_override=member_token, fail=True)
                assert binding['linkPropertyId'] == active['linkPropertyId']
                for bad_template in ['javascript:{appid}', 'https://{appid}/image.jpg', 'https://images.example.com/{__proto__.x}', 'https://images.example.com/{unclosed']:
                    bad = dict(binding, imageUrlTemplate=bad_template)
                    assert 'template' in call('save_shared_external_source', ['catalog', json.dumps(bad), {'none': []}, {'none': []}], fail=True).lower()
                for field, value in [('path','//evil.example/activity'),('targetField','__proto__'),('recordMatchPath','constructor.id'),('targetField','name')]:
                    bad = dict(binding, enrichments=[dict(binding['enrichments'][0], **{field:value})])
                    assert 'Additional lists' in call('save_shared_external_source', ['catalog', json.dumps(bad), {'none': []}, {'none': []}], fail=True)
                call('create_page', [{'some': database_id}, {'doc': []}, 'Untitled'])
                catalog_row = max(p['id'] for p in sql(f'SELECT id FROM page WHERE parent_pk = {database_id}'))
                call('set_property_value', [catalog_row, properties['Notes'], {'text': 'Catalog personal note'}])
                call('link_external_record_from_source', [catalog_row, 'catalog', '1', 'Catalog game'])
                assert 'Unlink' in call('disconnect_external_source', [database_id, 'catalog'], fail=True)
                before_other = sql(f'SELECT * FROM page_property_value WHERE page_id = {row_id}')
                catalog_env = dict(node_env, TEST_ROW_ID=str(catalog_row), TEST_SOURCE_ID='catalog')
                print(execute([ROOT / 'web/node_modules/.bin/tsx', ROOT / 'server/tests/multi_source_smoke.ts'], catalog_env), end='', flush=True)
                assert sql(f'SELECT * FROM page_property_value WHERE page_id = {row_id}') == before_other
                cells = sql(f'SELECT * FROM page_property_value WHERE page_id = {catalog_row}')
                assert any(c['value'] == [11, 120] for c in cells), cells
                assert any(c['value'] == [2, 1767225600000] for c in cells), cells
                assert any(c['property_definition_id'] == first_event_id and c['value'] == [2,1704067200000] for c in cells), cells
                Provider.activity_error = 503
                stable_cells = sql('SELECT * FROM page_property_value')
                failure = subprocess.run([str(ROOT / 'web/node_modules/.bin/tsx'), str(ROOT / 'server/tests/multi_source_smoke.ts')], env=catalog_env, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                assert failure.returncode != 0, failure.stdout
                assert sql('SELECT * FROM page_property_value') == stable_cells
                Provider.activity_error = 0
                print('PASS: additional API list maps first date in real SpacetimeDB; failed enrichment preserves every saved cell; unsafe paths and namespaces rejected', flush=True)
                assert 'Catalog personal note' in json.dumps(cells)
                assert sql(f'SELECT title FROM page WHERE id = {catalog_row}')[0]['title'] == 'Catalog game'
                assert 'sourceId' in json.dumps(cells)
                if os.environ.get('MULTI_SOURCE_BROWSER') == '1':
                    standalone = ROOT / 'web/.next/standalone/web'
                    shutil.copytree(ROOT / 'web/.next/static', standalone / '.next/static', dirs_exist_ok=True)
                    shutil.copytree(ROOT / 'web/public', standalone / 'public', dirs_exist_ok=True)
                    web_log = (temp / 'multi-web.log').open('w+')
                    web = subprocess.Popen(['node', str(standalone / 'server.js')], env=web_env, cwd=standalone, stdout=web_log, stderr=web_log)
                    try:
                        time.sleep(2)
                        browser_env = dict(node_env, TEST_WEB_ORIGIN=f'http://127.0.0.1:{web_port}')
                        print(execute(['node', ROOT / 'server/tests/multi_source_browser.cjs'], browser_env), end='', flush=True)
                    except BaseException:
                        web_log.flush(); web_log.seek(0); print(web_log.read()[-5000:])
                        raise
                    finally:
                        web.terminate()
                        try: web.wait(timeout=10)
                        except subprocess.TimeoutExpired: web.kill(); web.wait()
                        web_log.close()
                assert 'source' in call('apply_external_record', [catalog_row, json.dumps(active), '1', 'Wrong source', '[]'], fail=True).lower()
                call('link_external_record_from_source', [catalog_row, 'inventory', 'item-1', 'Desk lamp'])
                call('set_property_value', [catalog_row, properties['Elapsed'], {'duration': 999}])
                call('link_external_record_from_source', [catalog_row, 'catalog', 'item-1', 'Same ID other provider'])
                cells = sql(f'SELECT * FROM page_property_value WHERE page_id = {catalog_row}')
                assert not any(c['property_definition_id'] == properties['Elapsed'] for c in cells), cells
                assert 'Catalog personal note' in json.dumps(cells)
                assert 'configuration changed' in call('apply_external_record', [catalog_row, json.dumps(active), 'item-1', 'Desk lamp', '[]'], fail=True)
                binding['enabled'] = False
                call('configure_external_source', [database_id, json.dumps(binding), {'none': []}])
                call('set_property_value', [catalog_row, properties['Elapsed'], {'duration': 42}])
                call('link_external_record', [catalog_row, '', ''])
                assert any(c['value'] == [11, 42] for c in sql(f'SELECT * FROM page_property_value WHERE page_id = {catalog_row}'))
                call('disconnect_external_source', [database_id, 'catalog'])
                assert source_config(database_id) == active
                print('PASS: two sources share one hidden link column; numeric collection IDs; per-row source isolation; cross-source same-ID rebinding clears stale statistics; stale writes rejected; disabled unlink and disconnect preserve values', flush=True)

        except BaseException:
            log.flush(); log.seek(0)
            print(log.read()[-5000:])
            raise
        finally:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()
            provider.shutdown(); provider.server_close(); log.close()


if __name__ == '__main__':
    main()
