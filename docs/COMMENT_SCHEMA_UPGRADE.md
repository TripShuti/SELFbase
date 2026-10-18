# Block comment upgrade on SpacetimeDB 2.0.3

Commit `6fdfe255941ae3ddcfca28fa2ffabecc71151189` inserted
`author_email` between `author` and `content`. This shifted all subsequent
column positions. A default does not make an insertion in the middle safe:
2.0.3 rejects it as `Reordering table block_comment requires a manual migration`.
The failed publish leaves the original schema and records intact.

The fix appends `author_email: Option<String>` after `updated_at`, with an
explicit `#[default(Option::<String>::None)]`. Existing column positions, types,
indexes and primary keys stay intact. Publish requires `--break-clients` because
adding the column changes the client wire schema. Deploy the regenerated client
bindings with the module and reconnect clients.

References:
- [Automatic migrations](https://spacetimedb.com/docs/databases/automatic-migrations/)
- [Column defaults](https://spacetimedb.com/docs/tables/default-values/)
- [Incremental migrations](https://spacetimedb.com/docs/databases/incremental-migrations/)

## Deployment and recovery

1. Preserve a consistent backup of the database volume and the CLI configuration
   volume (`spacetimedb-data` and `spacetimedb-config`). Retain the owner identity.
2. Deploy the updated entrypoint, `server/docker/server.wasm`, and web bindings.
   Publish to the **existing** database using its owner's credentials, as the
   entrypoint already does, with `--break-clients`. No data deletion or database
   recreation is needed for the pre-commit schema.
3. After a successful publish, invoke `run_pending_migrations` as the publisher
   (the entrypoint does this automatically). The
   `block_comment_author_email_backfill_v2` step copies normalized emails from
   historical `User` rows, including logged-out identities, preserving all legacy
   comment fields. Its new key repairs databases where v1 already completed.
4. Check comments and migration state. Comments with no known author email
   remain unlinked. Once an email is available, the publisher can run
   `backfill_comment_authors` again. Existing email snapshots are never replaced.

A failed publish now logs the error, retains credentials and leaves the server
running with the previous module. It does not retry or run post-publish
migrations. Correct the reported problem and publish manually, or restart the
container once the corrected artifact/credentials are available.

If the old entrypoint already erased CLI credentials, this patch cannot recover
those private keys. Restore the database owner's CLI configuration from backup,
or use another retained copy of that owner's credentials. A newly generated
identity cannot publish to an existing database owned by another identity.

This append fix targets a database where the problematic publish was rejected.
If another database already has `author_email` in the middle (for example a fresh
installation of that commit), moving it to the end is itself a reorder. Do not
force that update. Keep its deployed schema, then use a separately tested staged
migration: add a new table with the target schema while retaining the original;
copy rows transactionally with their IDs and all author snapshots, dual-write
while copying (or pause writes); verify every row and switch readers/writers;
retain the original until verification and backup are complete. This requires
coordinated module and client changes; it is not implemented by this patch.

## Validation

Validated locally using the SpacetimeDB 2.0.3 CLI and standalone server with an
isolated database and credentials. The full module from the parent commit was
published with legacy comment fixtures; the original broken WASM was rejected,
and the corrected WASM upgraded the same database while preserving every legacy
comment field. Normalized email backfill from logged-out identities after v1 was already
marked complete, orphan preservation, repeat migrations
and publish, and authorization from another non-admin identity with the same
email all passed. Four entrypoint subprocess tests, shell syntax validation and
`git diff --check` also passed. Test scripts are retained locally and are not
included in this deployment commit.

To rebuild release artifacts with the same CLI version:

```sh
STDB203="$HOME/.local/share/spacetime/bin/2.0.3/spacetimedb-cli"
"$STDB203" build --module-path server/spacetimedb
cp server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm server/docker/server.wasm
"$STDB203" generate --lang typescript --bin-path server/docker/server.wasm --out-dir web/src/module_bindings --yes
```
