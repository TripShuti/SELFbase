# Deletion and data lifecycle

Moving a page to trash preserves its content, attachments, comments, values,
access rules and schema so it can be restored. Repeating a soft delete keeps
its original deletion timestamp. `delete_page_subtree` trashes descendants;
`delete_page` affects only the selected page.

## Permanent deletion

Manual purge requires a trashed page and write access. It removes the root and
its trashed descendants. Every page being removed must be writable by the
caller; an unauthorized trashed descendant refuses the whole manual purge
before any changes. Empty-trash skips such roots. Active descendants survive and move to the root's
parent. Grants from the removed ancestors are copied before detaching them, so
removing a restricted parent does not make surviving content public within the
workspace. Grants from surviving ancestors remain inherited, so later changes
and revocations on those ancestors still apply.

The daily retention job removes pages trashed more than 30 days ago. Each
child's deletion timestamp is checked independently: recently trashed children
survive and are reparented along with their access grants. Clients cannot call
the scheduled retention reducer directly.

Permanent deletion removes:

- Content, Yjs state, component nodes, snapshots and attachment metadata.
- Comments, page/block access rules and access requests scoped to the page.
- Current property values and their history on the removed page.
- Database views, schema definitions and their current/historical cells,
  including cells on rows that inherited a removed definition.
- The database's private external-source credential.
- Dependent API endpoint metadata, keys, field mappings, call logs and row
  creation markers. This is dependency cleanup, not a change to REST behavior.

Current relation cells on surviving pages lose references to removed pages;
other references remain. Previous relation values remain in history.
Deleting an individual column removes its cells, history, API field mappings and
external-source field mappings. Source binding revisions change so stale
in-flight snapshots cannot restore the removed mapping.

A database cannot be purged while a schema outside the purged subtree inherits
its schema, or while surviving rows still hold values in columns it owns. Move
those rows to trash before permanently deleting their database. Detach or purge
the dependent database first. These checks happen before any changes; automatic retention and empty-trash skip blocked roots.
Empty-trash may need another pass after a dependent database has been purged.

## External sources

A trashed database is excluded from background polling and direct source loads.
An in-flight record update is rejected if its row or database has been trashed
or removed. Restoring the database permits polling again. Saved source settings
remain until disconnection or permanent deletion so trash remains restorable.
Deleting a shared source still requires disconnecting its database bindings.

## File storage and existing orphan records

S3 object bytes are separate from attachment metadata. There is currently no
automatic S3 garbage collector, and these reducers cannot perform object-store
requests. Purging a page therefore does **not** reclaim its stored object bytes.
Do not delete objects merely because they lack an attachment row: editor blocks,
file properties and backups may also reference them.

These changes prevent new orphan records through the deletion paths. They do
not scan and delete pre-existing orphan rows or objects during deployment.

## Regression checks

Run from the repository root after building the release WASM:

```sh
cargo test --manifest-path server/spacetimedb/Cargo.toml --release
cargo build --manifest-path server/spacetimedb/Cargo.toml --target wasm32-unknown-unknown --release
python3 server/tests/deletion_regressions.py
python3 server/tests/external_source_regressions.py
```

The integration scripts use disposable localhost servers and temporary keys and
configuration. The deletion suite compares against the pre-fix artifact at
`84a26b0` and checks cleanup, inherited access, schema preflight, repeated delete
and scheduler authorization. Retention boundary cases also have Rust unit tests.
