# Updates, migrations and recovery

SELFbase pins SpacetimeDB to 2.0.3. A release consists of the server WASM,
its generated bindings and the corresponding web build. Building or merging a
PR does not update the module already loaded in a running database. The
entrypoint publishes the mounted artifact on the next container start.

## Existing installations

1. Prepare the new web image and matching committed server artifact. Back up
   the existing release and plan a maintenance window.
2. Stop writes from all clients, including integrations. Stop `web` and
   `spacetimedb` before taking a consistent cold backup of the database data
   and CLI configuration volumes. Preserve the database owner's CLI identity.
   Include S3 data separately; a JSON snapshot contains references, not blob
   bytes or private credentials.
3. Start the backend with the new artifact and entrypoint:

   ```sh
   docker compose up -d --wait --wait-timeout 420 spacetimedb
   ```

4. Verify readiness and logs, then start the corresponding web image:

   ```sh
   docker compose exec spacetimedb cat /tmp/selfbase-ready
   docker compose logs --tail 100 spacetimedb
   docker compose up -d web
   ```

   The readiness value must be `ready`. New web containers depend on a healthy
   backend. Compose dependency checks do not stop an already-running web
   container or block direct database traffic, which is why maintenance and
   stopping the old web container remain operator responsibilities.

## Startup contract

The entrypoint bounds startup, publish and migrations to 120 seconds each by
default. Configure `STDB_STARTUP_TIMEOUT`, `STDB_PUBLISH_TIMEOUT` and
`STDB_MIGRATION_TIMEOUT` as positive integer seconds without leading zeros.
The Compose health check allows six minutes for these phases; increase its
`start_period` and your Compose wait timeout if you increase the phase limits.
A successful health check becomes healthy immediately within this window.

The state file distinguishes `starting`, `ready`, `module-missing`,
`publish-failed`, `migration-failed` and `stopped`. It is reset on every start,
so an earlier successful deployment cannot make a failed update appear ready.
Health also checks that the database HTTP API responds.

On missing WASM, failed publish or failed migrations, the existing database
server stays available for diagnosis and recovery, but readiness is withheld.
CLI credentials are preserved, migrations are skipped after a failed publish,
and there is no automatic publish retry or database reset. Shutdown signals
are forwarded even while a bounded CLI operation is running.

`--no-config` prevents a checked-out `spacetime.json` from overriding the
explicit module/database/server arguments. `--break-clients` permits client
ABI changes; it does not clear data or permit arbitrary schema changes.

## Migration semantics

`run_pending_migrations` requires the publisher or a workspace admin. Migration
keys are append-only. Repeated successful calls skip recorded keys.

All pending steps run in **one reducer transaction**. A failure rolls back
changes and completion markers from that invocation; markers from earlier
successful calls remain. A CLI timeout does not prove the transaction failed:
the server may finish after the caller stops waiting. Inspect the outcome
before recovery; do not assume timeout means rollback.

The upgrade migrations repair `parent_pk` on both active and trashed pages,
carry legacy identity-level admin authority onto local account credentials,
and arm the existing trash-retention job. These steps have new keys, so they
also run on installations where older migration keys were already recorded.

## Failed update

Keep the new web stopped. Inspect the state file and publish/migration error,
fix the artifact, owner credentials or timeout, then explicitly restart the
backend with the intended release to repeat publish and idempotent migrations.
A successful manual reducer call alone does not reset a failed readiness flag.

Do not delete CLI configuration, create a replacement owner, use
`--clear-database`, or repeatedly force a rejected schema update. After a
successful migration, deploying an older WASM alone is not a guaranteed
rollback. Restore a matching backup of database data, owner configuration,
release artifacts and relevant blobs if a full rollback is needed.

## Regression checks

```sh
python3 server/tests/entrypoint_readiness.py
python3 server/tests/upgrade_regressions.py
python3 server/tests/container_upgrade.py
```

These use disposable subprocesses, local databases or containers and temporary
keys/configuration. The upgrade fixture is built from pre-change commit
`4cd90eb` with test-only legacy state; the candidate is the current release
WASM. The Docker suite uses the real pinned image and tests fresh startup,
old-to-new upgrade, repeat restart and invalid-artifact recovery without
mounting any live volumes or publishing host ports.
