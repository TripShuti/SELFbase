//! Chunked import of `selfbase-snapshot-v2` produced by the web client's
//! `buildSelfbaseSnapshotV2` (see `snapshot_tables_v2.json` for the canonical
//! table policy this module implements the import side of).
//!
//! Unlike v1's single-reducer JSON blob, v2 streams the snapshot in chunks so
//! large workspaces fit within reducer argument limits:
//!
//! 1. [`import_v2_begin`] — guards (empty db, authenticated caller, no live
//!    session), verifies the header format, creates the session lock.
//! 2. [`import_v2_chunk`] × N — one JSON array of rows per call, strictly
//!    sequenced (`seq == last_seq + 1`), dispatched per table.
//! 3. [`import_v2_commit`] — verifies per-table applied+skipped counts against
//!    the export manifest, resets the `id_counter` table, releases the session.
//!
//! Each chunk is its own transaction; an interrupted import leaves partial
//! rows behind. [`import_v2_abort`] releases the session lock only — recovery
//! from a partial import is `spacetime publish --clear-database` and re-run.

use super::decode::*;
use crate::auth::sender_is_admin;
use crate::{
    api_call_log, api_endpoint, api_endpoint_key, api_field_mapping, attachment, block_access_rule,
    block_comment, component_node, component_type_definition, component_yjs_state,
    database_row_marker, database_schema, database_view, id_counter, page, page_access_request,
    page_access_rule, page_content, page_property_value, page_property_value_history,
    page_snapshot, page_yjs_state, property_definition, user, user_preference, workspace_setting,
};
use crate::{
    AccessRequestStatus, ApiCallLog, ComponentCapability, ComponentNode, ComponentTypeDefinition,
    ComponentYjsState, DatabaseRowMarker, Page, PageAccessRequest, PageContentFormat,
};
use serde_json::Value;
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

/// Keep in sync with `SELFBASE_SNAPSHOT_V2_FORMAT` in `web/src/lib/selfbaseExport.ts`
/// and the `format` field of `snapshot_tables_v2.json`.
const FORMAT: &str = "selfbase-snapshot-v2";
/// Pre-rebrand format name — accepted on import so old exports still load.
const LEGACY_FORMAT: &str = "pear-snapshot-v2";

/// The fixed primary key of the single [`ImportSession`] row — at most one
/// import session may exist at a time.
const IMPORT_SESSION_ID: u64 = 1;

/// Every table this importer can dispatch. MUST match the `include` list of
/// `snapshot_tables_v2.json` exactly — enforced by
/// `dispatch_table_matches_policy_include_list` below (and mirrored on the
/// TypeScript side in `web/src/lib/selfbaseExport.test.ts`).
const IMPORT_V2_TABLES: &[&str] = &[
    "user",
    "user_preference",
    "workspace_setting",
    "page",
    "page_content",
    "page_yjs_state",
    "page_snapshot",
    "component_node",
    "component_yjs_state",
    "component_type_definition",
    "database_schema",
    "property_definition",
    "database_view",
    "page_property_value",
    "page_property_value_history",
    "database_row_marker",
    "attachment",
    "page_access_rule",
    "block_access_rule",
    "block_comment",
    "page_access_request",
    "api_endpoint",
    "api_field_mapping",
    "api_endpoint_key",
    "api_call_log",
];

// ── Session tables (private) ──────────────────────────────────────────────────

/// The single in-flight import session. Private — session state is importer
/// plumbing, never client data. `id` is always [`IMPORT_SESSION_ID`].
#[table(accessor = import_session)]
pub struct ImportSession {
    #[primary_key]
    pub id: u64,
    /// The authenticated user who called `import_v2_begin`; the only identity
    /// allowed to send chunks / commit (any admin may also abort).
    pub created_by: Identity,
    pub started_at: Timestamp,
    /// Sequence number of the last accepted chunk (0 before the first chunk).
    pub last_seq: u32,
}

/// Per-table applied/skipped row counts, accumulated across chunk
/// transactions and reconciled against the export manifest at commit time.
/// Private — see [`ImportSession`].
#[table(accessor = import_session_count)]
pub struct ImportSessionCount {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub table_name: String,
    /// Rows inserted into the table.
    pub applied: u64,
    /// Rows intentionally dropped by an import row guard (builtin harness
    /// templates / extension manifests / component types, and installed
    /// extensions pointing at seeded builtin manifests).
    pub skipped: u64,
}

// ── Reducers ──────────────────────────────────────────────────────────────────

/// Open a `selfbase-snapshot-v2` import session. Only succeeds when the database
/// has **no pages** (empty workspace), the caller is an authenticated user,
/// and no other session is in flight. `header_json` carries
/// `{"format":"selfbase-snapshot-v2"}` from the export header.
#[reducer]
pub fn import_v2_begin(ctx: &ReducerContext, header_json: String) -> Result<(), String> {
    if ctx.db.page().iter().next().is_some() {
        return Err(
            "Import refused: database already has pages. Use an empty database (new module DB)."
                .to_string(),
        );
    }

    let me = ctx.sender();
    let ok = ctx
        .db
        .user()
        .identity()
        .find(me)
        .map(|u| u.is_authenticated)
        .unwrap_or(false);
    if !ok {
        return Err("You must be logged in to import a snapshot.".to_string());
    }

    if ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .is_some()
    {
        return Err(
            "Import refused: an import session is already in progress. Abort it first \
             (import_v2_abort)."
                .to_string(),
        );
    }

    let root: Value = serde_json::from_str(&header_json).map_err(|e| format!("JSON parse: {e}"))?;
    let format = root
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or("missing format")?;
    if format != FORMAT && format != LEGACY_FORMAT {
        return Err(format!("unsupported format: {format}"));
    }

    ctx.db.import_session().insert(ImportSession {
        id: IMPORT_SESSION_ID,
        created_by: me,
        started_at: ctx.timestamp,
        last_seq: 0,
    });
    Ok(())
}

/// Apply one chunk of snapshot rows. `rows_json` is a JSON array of rows in
/// the same camelCase `__selfbase`-tagged encoding. Chunks are strictly
/// sequenced: `seq` must be `last_seq + 1`. Only the session creator may call.
#[reducer]
pub fn import_v2_chunk(
    ctx: &ReducerContext,
    seq: u32,
    table_name: String,
    rows_json: String,
) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress — call import_v2_begin first.")?;
    if ctx.sender() != session.created_by {
        return Err("Only the import session creator may send chunks.".to_string());
    }
    let expected = session.last_seq + 1;
    if seq != expected {
        return Err(format!(
            "chunk out of order: expected seq {expected}, got {seq}"
        ));
    }

    // Drift guard: refuse tables the policy doesn't include, so an export
    // built against a newer schema fails loudly instead of dropping rows.
    if !IMPORT_V2_TABLES.contains(&table_name.as_str()) {
        return Err(format!(
            "unknown snapshot table: {table_name} (not in the selfbase-snapshot-v2 include list)"
        ));
    }

    let rows: Value = serde_json::from_str(&rows_json).map_err(|e| format!("JSON parse: {e}"))?;
    let arr = rows.as_array().ok_or("rows_json: expected array")?;

    let (applied, skipped) = import_rows(ctx, &table_name, arr)?;
    record_counts(ctx, &table_name, applied, skipped);

    ctx.db.import_session().id().update(ImportSession {
        last_seq: seq,
        ..session
    });
    Ok(())
}

/// Finish an import session. `manifest_json` is `{"counts": {table: n}}` from
/// the export; every entry must satisfy `applied + skipped == n` or the whole
/// commit is refused (the session stays open so the caller can inspect/abort).
///
/// On success, deletes **all** `id_counter` rows: the next allocation re-seeds
/// each counter from the post-import `max(id)` of its table (the documented
/// reset path in `id_counters.rs`). This is what fixes the latent
/// seed-collision bug — counters seeded on the empty pre-import database
/// would otherwise hand out ids that collide with imported rows.
#[reducer]
pub fn import_v2_commit(ctx: &ReducerContext, manifest_json: String) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress — call import_v2_begin first.")?;
    if ctx.sender() != session.created_by {
        return Err("Only the import session creator may commit.".to_string());
    }

    let root: Value =
        serde_json::from_str(&manifest_json).map_err(|e| format!("JSON parse: {e}"))?;
    let counts = root
        .get("counts")
        .and_then(|v| v.as_object())
        .ok_or("missing counts")?;

    let mut mismatches: Vec<String> = Vec::new();
    for (name, expected) in counts {
        let expected = decode_u64(expected).map_err(|e| format!("counts.{name}: {e}"))?;
        let (applied, skipped) = counts_for(ctx, name);
        if applied + skipped != expected {
            mismatches.push(format!(
                "{name}: manifest {expected}, applied {applied} + skipped {skipped}"
            ));
        }
    }
    if !mismatches.is_empty() {
        return Err(format!(
            "Import count mismatch — commit refused (session left open): {}",
            mismatches.join("; ")
        ));
    }

    // Reset the id allocator (see doc comment above / id_counters.rs).
    let counter_names: Vec<String> = ctx.db.id_counter().iter().map(|r| r.name).collect();
    for name in counter_names {
        ctx.db.id_counter().name().delete(name);
    }

    clear_session(ctx);
    Ok(())
}

/// Abort an in-flight import session. The creator or any workspace admin may
/// call this. Only the session lock and counters are removed — **rows already
/// imported by earlier chunks remain** (chunks are separate transactions).
/// Recovery from a partial import is `spacetime publish --clear-database`
/// and a fresh import.
#[reducer]
pub fn import_v2_abort(ctx: &ReducerContext) -> Result<(), String> {
    let session = ctx
        .db
        .import_session()
        .id()
        .find(IMPORT_SESSION_ID)
        .ok_or("No import session in progress.")?;
    if ctx.sender() != session.created_by && !sender_is_admin(ctx) {
        return Err("Only the import session creator or a workspace admin may abort.".to_string());
    }
    clear_session(ctx);
    Ok(())
}

// ── Session helpers ───────────────────────────────────────────────────────────

fn clear_session(ctx: &ReducerContext) {
    ctx.db.import_session().id().delete(IMPORT_SESSION_ID);
    let count_ids: Vec<u64> = ctx.db.import_session_count().iter().map(|c| c.id).collect();
    for id in count_ids {
        ctx.db.import_session_count().id().delete(id);
    }
}

fn record_counts(ctx: &ReducerContext, table_name: &str, applied: u64, skipped: u64) {
    let existing = ctx
        .db
        .import_session_count()
        .iter()
        .find(|c| c.table_name == table_name);
    match existing {
        Some(c) => {
            let applied = c.applied + applied;
            let skipped = c.skipped + skipped;
            ctx.db
                .import_session_count()
                .id()
                .update(ImportSessionCount {
                    applied,
                    skipped,
                    ..c
                });
        }
        None => {
            ctx.db.import_session_count().insert(ImportSessionCount {
                id: 0,
                table_name: table_name.to_string(),
                applied,
                skipped,
            });
        }
    }
}

fn counts_for(ctx: &ReducerContext, table_name: &str) -> (u64, u64) {
    ctx.db
        .import_session_count()
        .iter()
        .find(|c| c.table_name == table_name)
        .map(|c| (c.applied, c.skipped))
        .unwrap_or((0, 0))
}

// ── Per-table dispatch ────────────────────────────────────────────────────────

/// Decode + insert every row of one chunk. Returns `(applied, skipped)`;
/// guard-skipped rows count as skipped, never as applied.
fn import_rows(
    ctx: &ReducerContext,
    table_name: &str,
    arr: &[Value],
) -> Result<(u64, u64), String> {
    // Plain arm: decode each row and insert it; nothing is ever skipped.
    macro_rules! plain {
        ($accessor:ident, $decode:path) => {{
            let mut applied = 0u64;
            for row in arr {
                ctx.db.$accessor().insert($decode(row)?);
                applied += 1;
            }
            (applied, 0u64)
        }};
    }

    let counts: (u64, u64) = match table_name {
        "user" => plain!(user, decode_user),
        "user_preference" => plain!(user_preference, decode_user_preference),
        "workspace_setting" => plain!(workspace_setting, decode_workspace_setting),
        "page" => plain!(page, decode_page),
        "page_content" => plain!(page_content, decode_page_content),
        "page_yjs_state" => plain!(page_yjs_state, decode_page_yjs_state),
        "page_snapshot" => plain!(page_snapshot, decode_page_snapshot),
        "component_node" => plain!(component_node, decode_component_node),
        "component_yjs_state" => plain!(component_yjs_state, decode_component_yjs_state),
        "component_type_definition" => {
            // Guard: builtin component types are re-seeded by init;
            // `component_node` references types by string, so id drift on the
            // seeded rows is harmless.
            let mut applied = 0u64;
            let mut skipped = 0u64;
            for row in arr {
                let def = decode_component_type_definition(row)?;
                if def.is_builtin {
                    skipped += 1;
                    continue;
                }
                ctx.db.component_type_definition().insert(def);
                applied += 1;
            }
            (applied, skipped)
        }
        "database_schema" => plain!(database_schema, decode_database_schema),
        "property_definition" => plain!(property_definition, decode_property_definition),
        "database_view" => plain!(database_view, decode_database_view),
        "page_property_value" => plain!(page_property_value, decode_page_property_value),
        "page_property_value_history" => {
            plain!(
                page_property_value_history,
                decode_page_property_value_history
            )
        }
        "database_row_marker" => plain!(database_row_marker, decode_database_row_marker),
        "attachment" => plain!(attachment, decode_attachment),
        "page_access_rule" => plain!(page_access_rule, decode_page_access_rule),
        "block_access_rule" => plain!(block_access_rule, decode_block_access_rule),
        "block_comment" => plain!(block_comment, decode_block_comment),
        "page_access_request" => plain!(page_access_request, decode_page_access_request),
        "api_endpoint" => plain!(api_endpoint, decode_api_endpoint),
        "api_field_mapping" => plain!(api_field_mapping, decode_api_field_mapping),
        "api_endpoint_key" => plain!(api_endpoint_key, decode_api_endpoint_key),
        "api_call_log" => plain!(api_call_log, decode_api_call_log),
        other => {
            return Err(format!(
                "unknown snapshot table: {other} (not in the selfbase-snapshot-v2 include list)"
            ))
        }
    };
    Ok(counts)
}

// ── v2 helpers ────────────────────────────────────────────────────────────────

fn opt_identity_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Identity>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_identity(v)?)),
    }
}

// ── v2 decoders ─────────────────────────────────────────────────────────────

fn decode_page_content_format(v: &Value) -> Result<PageContentFormat, String> {
    decode_enum_tag2(
        v,
        &[
            ("BlockNote", PageContentFormat::BlockNote),
            ("ComponentTree", PageContentFormat::ComponentTree),
        ],
        "PageContentFormat",
    )
}

fn decode_page(v: &Value) -> Result<Page, String> {
    let m = obj(v, "page")?;
    let parent_id = opt_u64_at(m, "parentId")?;
    Ok(Page {
        id: u64_at(m, "id")?,
        parent_id,
        page_type: decode_page_type(m.get("pageType").ok_or("pageType")?)?,
        title: string_at(m, "title")?,
        sort_order: u64_at(m, "sortOrder")? as u32,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
        icon: opt_string_at(m, "icon")?,
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: bool_at_or(m, "isHidden", false),
        // v2 round-trips the content format; absent (older exporter build)
        // falls back to BlockNote, matching the column default.
        content_format: match m.get("contentFormat") {
            None | Some(Value::Null) => PageContentFormat::BlockNote,
            Some(v) => decode_page_content_format(v)?,
        },
    })
}

// ── Decoders for tables new in v2 ─────────────────────────────────────────────

fn decode_component_node(v: &Value) -> Result<ComponentNode, String> {
    let m = obj(v, "component_node")?;
    Ok(ComponentNode {
        id: u64_at(m, "id")?,
        surface_id: u64_at(m, "surfaceId")?,
        parent_id: opt_u64_at(m, "parentId")?,
        component_type: string_at(m, "componentType")?,
        props: string_at(m, "props")?,
        order: u64_at(m, "order")? as u32,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        updated_by: decode_actor_type(m.get("updatedBy").ok_or("updatedBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
        deleted_at: opt_timestamp_at(m, "deletedAt")?,
    })
}

fn decode_component_yjs_state(v: &Value) -> Result<ComponentYjsState, String> {
    let m = obj(v, "component_yjs_state")?;
    Ok(ComponentYjsState {
        component_node_id: u64_at(m, "componentNodeId")?,
        data: decode_bytes(m.get("data").ok_or("data")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

fn decode_component_capability(v: &Value) -> Result<ComponentCapability, String> {
    decode_enum_tag2(
        v,
        &[
            ("ReadsDatabase", ComponentCapability::ReadsDatabase),
            ("ReadsProperty", ComponentCapability::ReadsProperty),
            ("WritesDatabase", ComponentCapability::WritesDatabase),
            ("WritesProperty", ComponentCapability::WritesProperty),
            ("DeletesRow", ComponentCapability::DeletesRow),
            ("NavigatesToPage", ComponentCapability::NavigatesToPage),
            ("OpensExternalUrl", ComponentCapability::OpensExternalUrl),
            (
                "TriggersAutomation",
                ComponentCapability::TriggersAutomation,
            ),
        ],
        "ComponentCapability",
    )
}

fn decode_component_capability_vec(v: &Value) -> Result<Vec<ComponentCapability>, String> {
    let arr = v.as_array().ok_or("capabilities: expected array")?;
    arr.iter().map(decode_component_capability).collect()
}

fn decode_component_type_definition(v: &Value) -> Result<ComponentTypeDefinition, String> {
    let m = obj(v, "component_type_definition")?;
    Ok(ComponentTypeDefinition {
        id: u64_at(m, "id")?,
        component_type: string_at(m, "componentType")?,
        display_name: string_at(m, "displayName")?,
        description: string_at(m, "description")?,
        prop_schema: string_at(m, "propSchema")?,
        capabilities: decode_component_capability_vec(
            m.get("capabilities").ok_or("capabilities")?,
        )?,
        has_yjs_state: bool_at(m, "hasYjsState")?,
        accepts_children: bool_at(m, "acceptsChildren")?,
        is_builtin: bool_at(m, "isBuiltin")?,
        registered_by: decode_identity(m.get("registeredBy").ok_or("registeredBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_database_row_marker(v: &Value) -> Result<DatabaseRowMarker, String> {
    let m = obj(v, "database_row_marker")?;
    Ok(DatabaseRowMarker {
        id: u64_at(m, "id")?,
        client_request_id: string_at(m, "clientRequestId")?,
        page_id: u64_at(m, "pageId")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

fn decode_access_request_status(v: &Value) -> Result<AccessRequestStatus, String> {
    decode_enum_tag2(
        v,
        &[
            ("Pending", AccessRequestStatus::Pending),
            ("Approved", AccessRequestStatus::Approved),
            ("Denied", AccessRequestStatus::Denied),
        ],
        "AccessRequestStatus",
    )
}

fn decode_page_access_request(v: &Value) -> Result<PageAccessRequest, String> {
    let m = obj(v, "page_access_request")?;
    Ok(PageAccessRequest {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        principal: decode_principal(m.get("principal").ok_or("principal")?)?,
        permission: decode_permission(m.get("permission").ok_or("permission")?)?,
        requested_by: decode_identity(m.get("requestedBy").ok_or("requestedBy")?)?,
        reason: string_at(m, "reason")?,
        status: decode_access_request_status(m.get("status").ok_or("status")?)?,
        requested_at: decode_timestamp(m.get("requestedAt").ok_or("requestedAt")?)?,
        resolved_by: opt_identity_at(m, "resolvedBy")?,
        resolved_at: opt_timestamp_at(m, "resolvedAt")?,
    })
}

fn decode_api_call_log(v: &Value) -> Result<ApiCallLog, String> {
    let m = obj(v, "api_call_log")?;
    Ok(ApiCallLog {
        id: u64_at(m, "id")?,
        endpoint_id: u64_at(m, "endpointId")?,
        key_id: opt_u64_at(m, "keyId")?,
        method: decode_http_method(m.get("method").ok_or("method")?)?,
        path: string_at(m, "path")?,
        status_code: u64_at(m, "statusCode")? as u16,
        latency_ms: u64_at(m, "latencyMs")? as u32,
        caller_ip: opt_string_at(m, "callerIp")?,
        error_message: opt_string_at(m, "errorMessage")?,
        at: decode_timestamp(m.get("at").ok_or("at")?)?,
    })
}

fn decode_block_comment(v: &Value) -> Result<crate::comments::BlockComment, String> {
    use crate::comments::BlockComment;
    let m = obj(v, "block_comment")?;
    Ok(BlockComment {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        block_id: opt_string_at(m, "blockId")?,
        parent_id: opt_u64_at(m, "parentId")?,
        author: decode_identity(m.get("author").ok_or("author")?)?,
        content: string_at(m, "content")?,
        resolved: bool_at(m, "resolved")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod snapshot_v2_tests {
    use super::*;
    use serde_json::json;

    const TS: &str = r#"{"__pear":"timestamp","v":"1700000000000000"}"#;
    const ID_HEX: &str = "c200000000000000000000000000000000000000000000000000000000000042";

    fn ts() -> Value {
        serde_json::from_str(TS).unwrap()
    }

    fn ident() -> Value {
        json!({"__pear": "identity", "v": ID_HEX})
    }

    /// Keep in sync with `SELFBASE_SNAPSHOT_V2_FORMAT` in
    /// `web/src/lib/selfbaseExport.ts` and `snapshot_tables_v2.json`.
    #[test]
    fn portable_snapshot_format_constant() {
        assert_eq!(FORMAT, "selfbase-snapshot-v2");
    }

    /// The importer's dispatch table must equal the policy's include list
    /// exactly — a module table added without updating both fails here (and
    /// the TS-side twin in `web/src/lib/selfbaseExport.test.ts`).
    #[test]
    fn dispatch_table_matches_policy_include_list() {
        let policy: Value =
            serde_json::from_str(include_str!("../../snapshot_tables_v2.json")).unwrap();
        assert_eq!(policy["format"].as_str(), Some(FORMAT));
        let include: Vec<&str> = policy["include"]
            .as_array()
            .expect("policy include list")
            .iter()
            .map(|v| v.as_str().expect("table name"))
            .collect();

        let policy_set: std::collections::BTreeSet<&str> = include.iter().copied().collect();
        let dispatch_set: std::collections::BTreeSet<&str> =
            IMPORT_V2_TABLES.iter().copied().collect();
        assert_eq!(
            include.len(),
            policy_set.len(),
            "duplicate in policy include list"
        );
        assert_eq!(
            IMPORT_V2_TABLES.len(),
            dispatch_set.len(),
            "duplicate in IMPORT_V2_TABLES"
        );
        assert_eq!(
            dispatch_set, policy_set,
            "IMPORT_V2_TABLES and snapshot_tables_v2.json include list diverged"
        );
    }

    #[test]
    fn decodes_component_node() {
        let row = json!({
            "id": {"__pear": "bigint", "v": "12"},
            "surfaceId": 7,
            "parentId": null,
            "componentType": "Container",
            "props": "{\"layout\":\"stack\"}",
            "order": 1000,
            "createdBy": {"tag": "Human"},
            "updatedBy": {"tag": "Agent", "value": "kira"},
            "createdAt": ts(),
            "updatedAt": ts(),
            "deletedAt": null,
        });
        let node = decode_component_node(&row).unwrap();
        assert_eq!(node.id, 12);
        assert_eq!(node.surface_id, 7);
        assert_eq!(node.parent_id, None);
        assert_eq!(node.component_type, "Container");
        assert_eq!(node.order, 1000);
        assert_eq!(node.created_by, crate::ActorType::Human);
        assert_eq!(node.updated_by, crate::ActorType::Agent("kira".to_string()));
        assert_eq!(node.deleted_at, None);
        assert_eq!(
            node.created_at,
            Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000)
        );
    }

    /// Builtin component types are re-seeded by init; the chunk importer's
    /// guard skips any decoded row with `is_builtin == true` (see the
    /// `component_type_definition` arm in `import_rows`).
    #[test]
    fn builtin_component_type_definition_decodes_as_builtin() {
        let row = json!({
            "id": 1,
            "componentType": "Container",
            "displayName": "Container",
            "description": "Layout container.",
            "propSchema": "{}",
            "capabilities": [{"tag": "ReadsDatabase"}, "WritesDatabase"],
            "hasYjsState": false,
            "acceptsChildren": true,
            "isBuiltin": true,
            "registeredBy": ident(),
            "createdAt": ts(),
        });
        let def = decode_component_type_definition(&row).unwrap();
        assert!(def.is_builtin, "guard keys on is_builtin");
        assert_eq!(
            def.capabilities,
            vec![
                ComponentCapability::ReadsDatabase,
                ComponentCapability::WritesDatabase
            ]
        );
    }

    // NOTE (manual verification): the id_counter reset in `import_v2_commit`
    // (delete every `id_counter` row so the next `alloc_id` re-seeds from the
    // post-import max(id) — see id_counters.rs) requires a `ReducerContext`
    // and cannot be unit-tested off-host. Verify on a dev module with:
    //   1. import a snapshot, 2. `SELECT * FROM id_counter` → empty,
    //   3. create a page → id == max(imported page id) + 1.
}
