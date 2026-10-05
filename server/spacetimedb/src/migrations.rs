//! `MigrationState` table + the standardised `run_pending_migrations`
//! reducer and its backfills. Hosts typically invoke this reducer after each
//! successful `publish_module` (automation, CI, or manual operator flow).

use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

use crate::module_install::ensure_publisher_identity_recorded;
use crate::pages::components::seed_builtin_component_types;
use crate::pages::components::{
    migrate_container_style_v1, migrate_heading_yjs_registry_v1,
    migrate_interactive_control_registry_v1,
};
use crate::pages::{page, Page};

/// Records which one-shot data migrations have already run on this database.
///
/// CONTRACT: whoever publishes this WASM should call `run_pending_migrations`
/// after every successful `publish_module` (fresh database and version
/// upgrades). The reducer is responsible for deciding what's new based on
/// rows in this table — it MUST NOT re-run a migration whose key is
/// already recorded. See `run_pending_migrations` for the canonical list.
///
/// Keys are free-form strings (e.g. `"page_parent_pk_backfill_v1"`) and
/// MUST be unique-and-stable across releases — once recorded, the same
/// key will never re-run, so changing data semantics requires a new key.
#[table(accessor = migration_state, public)]
pub struct MigrationState {
    #[primary_key]
    pub key: String,
    pub completed_at: Timestamp,
    /// Module version (`Cargo.toml`'s `[package].version`) that introduced
    /// this migration. Stored for forensics — not used for dispatch.
    pub module_version: String,
}

// ----------------------------------------------------------------------
// Migrations: standardised post-upgrade hook
// ----------------------------------------------------------------------
//
// CONTRACT (host ↔ module):
//
//   After every successful `publish_module` (fresh database and version
//   upgrades), invoke `run_pending_migrations` with credentials that can
//   run privileged reducers for this database (often the module publisher).
//
//   Each migration step:
//     1. Has a stable, unique key (string).
//     2. Checks `MigrationState` for that key — skips if already recorded.
//     3. Runs its work (typically a backfill or one-shot data transform).
//     4. Inserts a `MigrationState` row to mark itself complete.
//
// Keys are append-only — once shipped, NEVER rename or re-use one. To
// re-run the SAME logic on already-migrated databases, define a new key
// with a `_v2` suffix.
//
// New migrations are added by:
//   - Implementing the body as a private `fn` returning `Result<(), String>`.
//   - Appending a `run_step!(ctx, "<key>", <fn>);` line to
//     `run_pending_migrations` below.
//
// Failure of any step short-circuits the whole reducer — the next scheduled
// or manual retry will run again. State is committed per-step, so a
// partial failure doesn't roll back already-completed migrations.

/// Standardised post-publish hook: call after each successful
/// `publish_module`. Idempotent and safe to call repeatedly. Adds new
/// `MigrationState` rows for any unfinished migrations.
#[reducer]
pub fn run_pending_migrations(ctx: &ReducerContext) -> Result<(), String> {
    macro_rules! run_step {
        ($ctx:expr, $key:expr, $body:expr) => {{
            let key: &str = $key;
            if $ctx
                .db
                .migration_state()
                .key()
                .find(&key.to_string())
                .is_none()
            {
                $body($ctx)?;
                $ctx.db.migration_state().insert(MigrationState {
                    key: key.to_string(),
                    completed_at: $ctx.timestamp,
                    module_version: env!("CARGO_PKG_VERSION").to_string(),
                });
                log::info!("migration completed: {key}");
            }
        }};
    }

    run_step!(
        ctx,
        "page_parent_pk_backfill_v1",
        backfill_page_parent_pk_inner
    );
    run_step!(
        ctx,
        "module_install_meta_publisher_v1",
        |ctx: &ReducerContext| {
            ensure_publisher_identity_recorded(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_registry_seed_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_sprint4_builtins_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_document_lists_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_type_markdown_table_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    run_step!(
        ctx,
        "component_heading_yjs_registry_v1",
        |ctx: &ReducerContext| {
            migrate_heading_yjs_registry_v1(ctx);
            Ok::<(), String>(())
        }
    );
    // Re-apply the current Heading definition so existing workspaces pick up
    // the `section` prop added to `prop_schemas::HEADING` (collapsible-section
    // headings). `migrate_heading_yjs_registry_v1` reassigns the live row to
    // the current builtin schema — idempotent to re-run under a new step.
    run_step!(
        ctx,
        "component_heading_section_prop_v1",
        |ctx: &ReducerContext| {
            migrate_heading_yjs_registry_v1(ctx);
            Ok::<(), String>(())
        }
    );
    // Custom-view runtime M2: seeds the `Repeater` component type.
    run_step!(ctx, "component_type_repeater_v1", |ctx: &ReducerContext| {
        seed_builtin_component_types(ctx);
        Ok::<(), String>(())
    });
    // Style vocabulary S1: publishes the `style_v1` token block on the live
    // `Container` definition (the seed only inserts missing types).
    run_step!(
        ctx,
        "component_container_style_v1",
        |ctx: &ReducerContext| {
            migrate_container_style_v1(ctx);
            Ok::<(), String>(())
        }
    );
    // Interactive generated UI: publish the current UpdateProperty schema
    // (including payload-backed values).
    run_step!(
        ctx,
        "component_interactive_controls_v1",
        |ctx: &ReducerContext| {
            migrate_interactive_control_registry_v1(ctx);
            Ok::<(), String>(())
        }
    );
    // Generic file attachment block: seeds the `FileBlock` component type so
    // the slash menu can offer "File" next to Image / Audio.
    run_step!(
        ctx,
        "component_type_file_block_v1",
        |ctx: &ReducerContext| {
            seed_builtin_component_types(ctx);
            Ok::<(), String>(())
        }
    );
    Ok(())
}

/// Backfill `Page.parent_pk` from `Page.parent_id` for rows that predate
/// the field. Skips soft-deleted pages (the API gateway never queries
/// them) so the on-disk diff stays small.
fn backfill_page_parent_pk_inner(ctx: &ReducerContext) -> Result<(), String> {
    let stale: Vec<Page> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none() && p.parent_pk != p.parent_id.unwrap_or(0))
        .collect();

    let n = stale.len();
    for page in stale {
        let parent_pk = page.parent_id.unwrap_or(0);
        ctx.db.page().id().update(Page { parent_pk, ..page });
    }
    log::info!("page_parent_pk_backfill_v1: updated {n} rows");
    Ok(())
}
