# Running checks

Run from the repository root. Use Node 22 (the Docker build uses this version),
Python 3.12+, Rust/Cargo and the pinned pnpm 10.6.2:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

If `pnpm` is already on PATH, the `corepack` prefix is optional. The runner itself
needs only Python's standard library; `python3 scripts/check.py quick` runs the
same checks without invoking pnpm. The first quick step re-verifies the runner's
own failure propagation, timeout cleanup and prerequisite handling
(`scripts/test_check.py`).

## Profiles

| Command | Checks | Extra requirements |
| --- | --- | --- |
| `pnpm check` or `pnpm test` | Runner self-checks, web and editor unit tests, all three TypeScript packages and manual probe types, Rust unit tests, both entrypoint subprocess suites | GNU `timeout`, standard POSIX tools |
| `pnpm check:integration` | Build one candidate WASM; access-control, external-source, snapshot, deletion, migration and comment-schema upgrade regressions | SpacetimeDB CLI **and standalone 2.0.3**, WASM target, OpenSSL, full Git history |
| `pnpm check:browser` | Editor autosave and subscription lifecycle with real Chromium/IndexedDB | Playwright Chromium |
| `pnpm check:docker` | Build candidate; fresh container, old-to-new upgrade, restart and failed publish | Docker daemon, Compose v2, local pinned image, full Git history |
| `pnpm check:build` | Release WASM and production Next.js build | Rust WASM target |
| `pnpm check:all` | Every profile above, with one candidate WASM build | All prerequisites above |

The default check does not start Docker or a database. Integration tests create
localhost servers with temporary data and identities. Docker tests use disposable
containers without host ports or live volumes. Browser tests use a temporary
localhost server and simulated SDK/reducers.

Before a full run:

```sh
rustup target add wasm32-unknown-unknown
# Install SpacetimeDB CLI + standalone version 2.0.3.
# If installed outside the default Linux version-manager directory:
export TEST_SPACETIME_BIN_DIR=/path/to/spacetime/bin/2.0.3
corepack pnpm exec playwright install chromium
# On a machine missing browser OS libraries, use install --with-deps chromium.
docker pull clockworklabs/spacetime:v2.0.3
corepack pnpm check:all
```

The default CLI directory is `~/.local/share/spacetime/bin/2.0.3`. It must contain
`spacetimedb-cli` and `spacetimedb-standalone`; a newer executable elsewhere on
PATH does not replace the pinned test toolchain. Docker image downloads and
browser installation are explicit setup steps, not hidden test-runner actions.

## Results and failures

```sh
python3 scripts/check.py all --list
```

This lists the execution plan without checking dependencies or running anything.
A normal run checks prerequisites first, labels every step, streams its output
and prints a final count and elapsed time. Missing prerequisites exit with code
2. Failed/timed-out steps stop the run and exit with code 1; Ctrl+C exits with
130. Remaining steps are reported as not run. Missing Docker, Chromium or Git
history never silently turns the full run into a partial success.

Historical upgrade fixtures may compile additional legacy modules in temporary
directories. Checks run sequentially to avoid racing the Cargo artifact/cache and overloading
small development machines. Long-running steps have deadlines. Cancellation first
interrupts the child process group so disposable test servers can clean up.

## Candidate WASM and history

Every integrated suite uses the same **just-built** candidate from the selected
Cargo target directory. The runner sets `TEST_MODULE_WASM` for child scripts;
it does not copy over `server/docker/server.wasm` or regenerate tracked bindings.
Updating the committed release artifact/bindings remains a separate deployment
step described in [UPGRADES.md](./UPGRADES.md).

`CARGO_TARGET_DIR` can choose a different build/cache directory. Relative paths
are resolved against the repository root. When running an individual Python
regression directly, `TEST_MODULE_WASM` can select an explicit artifact; otherwise
it uses the release WASM in the selected Cargo target directory. This avoids
some suites testing a rebuilt module while others test the older committed file.

Historical fixtures use commits `79e9317`, `139085a`, `84a26b0`, `4cd90eb` and `6fdfe25`.
Keep full Git history; for a shallow clone use `git fetch --unshallow origin`.
The snapshot baseline uses `139085a`, whose WASM is identical to the former
`d2c60f1` baseline but is reachable from main after the historical rewrite.

## Coverage boundaries

Web tests include pure hook helpers as well as library tests. Editor tests run
under happy-dom; browser lifecycle checks are separate because they exercise real
React effects and IndexedDB. The full profile invokes all configured suites; it
is not a complete browser end-to-end test of every SELFbase screen or a load test.
Manual/live-provider probes and migration/import tools are not run automatically.
No test runner deploys to the user's running SELFbase installation.

## Manual live-provider probes

All test sources are tracked, including the Steam and Jellyfin read-only probes.
They are typechecked by the regular profile but never contact a live provider as
part of `check:all`. Configure the target explicitly before invoking them:

- `SELFBASE_STDB_URL`, `SELFBASE_STDB_DB_NAME`, `SELFBASE_STDB_TOKEN`: the target
  instance and its service credentials, supplied in your environment.
- `TEST_DATABASE_ID`: the database with the saved provider connection.
- `TEST_SOURCE_ID`: optional connection selection for a multi-source database.
- Jellyfin also requires `TEST_STATUS_PROPERTY_ID` and `TEST_DATE_PROPERTY_ID`
  for two properties already mapped by that connection.

```sh
corepack pnpm --filter @selfbase/web exec tsx ../server/tests/enrichment_live_steam.ts
corepack pnpm --filter @selfbase/web exec tsx ../server/tests/jellyfin_readonly_rules.ts
```

The probes read the saved source and make provider GET requests. Mapping changes
stay in memory; neither probe calls a reducer or writes to the provider. They
report aggregate results instead of titles, personal history or credentials.
They no longer rely on a named running container or hardcoded workspace IDs.
