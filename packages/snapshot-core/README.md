# Snapshot v2 restore integrity

`parseSelfbaseSnapshotJson` and `chunkSelfbaseSnapshotV2` share preflight checks:

- The canonical table policy must be complete in both `tables` and `counts`,
  including empty tables; unknown tables and count mismatches are rejected.
- Metadata, row objects, primary keys, duplicates, lossless u64 IDs, tagged
  identities/timestamps/base64 bytes, and nesting are checked before writes.
- Chunk order follows the canonical policy, independent of JSON object order.
- Table-specific business fields are decoded by the server. Preflight does not
  replace server schema validation or prove every foreign reference is valid.

Older or hand-edited v2 files with missing tables are refused rather than
silently treating missing data as empty. Keep the original backup when repairing
an incomplete file; do not populate missing tables with empty arrays unless
those tables were actually empty in the source.

The browser and CLI use `restoreSelfbaseSnapshotV2`. It serializes the complete
payload before begin, runs chunks sequentially, and requires a successful commit.
Each reducer acknowledgement has a 60-second deadline. A timeout does not prove
that the server rejected the request: the write or commit might have succeeded.
There are no automatic write retries or automatic aborts, including after a
failed begin that may belong to an existing import session.

## Recovering an interrupted restore

The import is **not atomic across chunks**. A failed chunk rolls back that
chunk; previous successful chunks remain. `import_v2_abort` releases the session
lock and bookkeeping only, without removing imported rows. It is not rollback
and does not make a partially restored destination empty again.

Preserve the source snapshot and check the destination before retrying,
especially if only the commit acknowledgement was lost. For an incomplete
restore, the supported recovery is a fresh empty database, or explicitly clearing
only the failed restore target before a new import. Do not clear a live workspace
or use abort as a cleanup shortcut. The UI and CLI explain the partial-write risk
and leave the failed session intact for inspection.

Identity hex is decoded in big-endian order to match SDK exports. A restoring
identity already present in its own backup is restored in place, retaining its
current authenticated/admin state. This does not recreate private native
credentials or OIDC configuration for other users. Previous imports performed
with the old byte-order bug are not automatically rewritten; verify them against
the original snapshot before deciding how to recover.

`blobManifest` contains object-storage references, not binary attachment data.
Restore/preserve the corresponding S3 objects separately.

## Regression checks

Run the web test suite for preflight and orchestration cases. Rust tests cover
identity byte order and complete commit manifests. To exercise real SpacetimeDB
2.0.3 transactions, SDK round-trip and CLI restore in a disposable local server:

```sh
cargo build --manifest-path server/spacetimedb/Cargo.toml --target wasm32-unknown-unknown --release
python3 server/tests/snapshot_restore_regressions.py
```

The runner uses temporary keys, configuration, data and a random localhost port;
it does not connect to the running workspace. Set `TEST_SPACETIME_BIN_DIR` if the
pinned binaries are not in `~/.local/share/spacetime/bin/2.0.3`.

The baseline comparison uses the WASM from commit `139085a`; keep that Git
history available, or set `TEST_BASELINE_WASM` to the corresponding old module.
