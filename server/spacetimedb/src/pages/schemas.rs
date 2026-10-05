//! Database schemas: column structure for `Database` pages, the cells
//! that store the current value (`PagePropertyValue`), and an
//! append-only history of every change (`PagePropertyValueHistory`).

use spacetimedb::{reducer, table, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::require_page_write;
use crate::id_counters::alloc_id;
use crate::pages::{page, ActorType};

/// Resolve a schema to its owning page and require write access on it.
/// Structural schema reducers (columns, config, inheritance) carry only a
/// `schema_id`; this maps that back to the page the access rules live on.
pub(crate) fn require_schema_write(ctx: &ReducerContext, schema_id: u64) -> Result<(), String> {
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    require_page_write(ctx, schema.page_id)
}

/// Resolve a property definition -> schema -> owning page and require write.
pub(crate) fn require_property_write(
    ctx: &ReducerContext,
    property_definition_id: u64,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    require_schema_write(ctx, prop.schema_id)
}

pub(crate) fn next_database_schema_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "database_schema", || {
        ctx.db
            .database_schema()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_property_definition_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "property_definition", || {
        ctx.db
            .property_definition()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_page_property_value_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_property_value", || {
        ctx.db
            .page_property_value()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_page_property_value_history_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "page_property_value_history", || {
        ctx.db
            .page_property_value_history()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyType {
    Text,
    Number,
    Date,
    Select,
    MultiSelect,
    Relation,
    Checkbox,
    Url,
    Person,
    /// Computed by an AI primitive over other columns of the same row.
    /// Configuration (primitive, model, prompt, output schema, invalidation
    /// policy) lives in `PropertyDefinition.config` as JSON; current
    /// materialised value lives in the same `PagePropertyValue` row as
    /// any other column. Evaluation history (cache + cost) lives in
    /// `AiEvaluation`.
    Ai,
    /// Expression stored in PropertyDefinition.config as { "expression": "..." }.
    /// Evaluated client-side in real time against sibling property values.
    Formula,
    /// Aggregation over related rows. Config: { "relationPropertyId": u64, "rollupPropertyId": u64, "function": "sum"|"count"|... }
    /// Evaluated client-side from subscribed related row data.
    Rollup,
    /// File/image attachments on a row (Notion "Files & media" equivalent).
    /// Values are `PropertyValue::File` lists of workspace blobs or external
    /// URLs.
    File,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Date(u64),
    Select(String),
    MultiSelect(Vec<String>),
    Relation(Vec<u64>),
    Checkbox(bool),
    Url(String),
    /// Identity hex strings of assigned users.
    Person(Vec<String>),
    /// Materialised AI primitive output, paired with the `AiEvaluation.id`
    /// it was produced by so the UI can show provenance and cost without a
    /// separate query.
    Ai(AiPropertyValue),
    /// Files attached to a File-type property cell.
    File(Vec<FileRef>),
}

/// One file in a File-type property cell. Exactly one of `object_id`
/// (workspace blob, rendered via the blob route with the current workspace
/// slug — id rather than URL so snapshots restore across slugs) or
/// `external_url` is non-empty.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct FileRef {
    pub name: String,
    pub object_id: String,
    pub external_url: String,
}

/// Materialised value of an AI column. The output is intentionally a
/// `String` even for "extract" / "classify" — the rendering layer reads
/// the column's `output_schema_json` to decide how to display it (chip,
/// number, sub-table, etc.). Storing as a string also keeps the cell
/// schema-stable when the prompt's output schema evolves.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct AiPropertyValue {
    pub output: String,
    pub evaluation_id: u64,
    pub is_stale: bool,
}

/// Set of supported AI primitives. Each maps to a worker handler that
/// validates output against `AiColumnConfig.output_schema_json` before
/// committing.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AiPrimitive {
    /// Pick one of N labels.
    Classify,
    /// Pull structured fields out of input text.
    Extract,
    /// Compress to N words/sentences.
    Summarize,
    /// Score Positive / Negative / Neutral with confidence.
    Sentiment,
    /// Translate to a target language.
    Translate,
}

/// Controls when a materialised `AiPropertyValue` is considered stale.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InvalidationPolicy {
    /// Recompute whenever any column referenced by `AiColumnConfig.input_columns`
    /// changes on the row. Default for most primitives.
    OnInputChange,
    /// Never auto-recompute — only manual `recompute_ai_cell`. Useful for
    /// expensive primitives where the operator wants to manage cost.
    Manual,
    /// Never invalidate. Useful for one-shot enrichment.
    Never,
}

/// Column structure definition for a Database page.
#[table(accessor = database_schema, public)]
pub struct DatabaseSchema {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub name: String,
    /// JSON config for schema-level settings (e.g. name column default).
    #[default(None::<String>)]
    pub config: Option<String>,
    /// OOP-style schema inheritance. When set, this schema's *effective*
    /// columns are the ancestor chain's `PropertyDefinition`s (root-first)
    /// followed by its own. Inherited columns keep their original
    /// `property_definition_id`, so `PagePropertyValue` rows on child-db
    /// pages reference parent definitions directly — no copying, no ID
    /// remapping. Single inheritance only; cycles are rejected by
    /// `set_schema_parent`.
    #[default(None::<u64>)]
    pub parent_schema_id: Option<u64>,
}

/// Each column in a database schema.
#[table(accessor = property_definition, public)]
pub struct PropertyDefinition {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub schema_id: u64,
    pub name: String,
    pub property_type: PropertyType,
    pub config: String,
    pub order: u32,
}

/// Current property value for a page (row).
#[table(accessor = page_property_value, public)]
pub struct PagePropertyValue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
}

/// Append-only history of every property value change.
#[table(accessor = page_property_value_history, public)]
pub struct PagePropertyValueHistory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
    pub is_current: bool,
    pub changed_at: Timestamp,
    pub changed_by: ActorType,
}

// ============================================================
// Schema inheritance helpers
// ============================================================

/// Hard cap on inheritance depth. Generous for real use; bounds the walk
/// if data is ever corrupted into a cycle despite the reducer guard.
const MAX_SCHEMA_CHAIN_DEPTH: usize = 32;

/// Per-schema system columns that are intentionally present on every
/// schema (seeded, not user-created). Exempt from shadowing checks so
/// linking two seeded schemas doesn't spuriously conflict.
const SYSTEM_PROPERTY_NAMES: &[&str] = &["agent_instruction"];

/// Ancestor chain for a schema, child-first: `[schema_id, parent, ...]`.
/// Stops at the root, at a dangling parent reference, or at
/// `MAX_SCHEMA_CHAIN_DEPTH`.
pub(crate) fn schema_ancestor_chain(ctx: &ReducerContext, schema_id: u64) -> Vec<u64> {
    let mut chain = Vec::new();
    let mut current = Some(schema_id);
    while let Some(id) = current {
        if chain.contains(&id) || chain.len() >= MAX_SCHEMA_CHAIN_DEPTH {
            break;
        }
        chain.push(id);
        current = ctx
            .db
            .database_schema()
            .id()
            .find(id)
            .and_then(|s| s.parent_schema_id);
    }
    chain
}

/// Direct + transitive child schema ids of `schema_id` (excluding itself).
/// Full-scan BFS — the schema table holds one row per database, so this
/// stays small.
pub(crate) fn schema_descendants(ctx: &ReducerContext, schema_id: u64) -> Vec<u64> {
    let all: Vec<(u64, Option<u64>)> = ctx
        .db
        .database_schema()
        .iter()
        .map(|s| (s.id, s.parent_schema_id))
        .collect();
    let mut found: Vec<u64> = Vec::new();
    let mut frontier = vec![schema_id];
    while let Some(pid) = frontier.pop() {
        for (id, parent) in &all {
            if *parent == Some(pid) && !found.contains(id) {
                found.push(*id);
                frontier.push(*id);
            }
        }
    }
    found
}

/// Resolved column set for a schema: ancestor definitions root-first,
/// own definitions last, each schema's block sorted by `order`. Inherited
/// definitions keep their original ids — write paths need no remapping.
pub(crate) fn effective_property_definitions(
    ctx: &ReducerContext,
    schema_id: u64,
) -> Vec<PropertyDefinition> {
    let mut defs = Vec::new();
    for sid in schema_ancestor_chain(ctx, schema_id).into_iter().rev() {
        let mut block: Vec<PropertyDefinition> =
            ctx.db.property_definition().schema_id().filter(&sid).collect();
        block.sort_by_key(|p| p.order);
        defs.extend(block);
    }
    defs
}

/// No-shadowing rule (v1): a property name must be unique across a
/// schema's whole inheritance chain — ancestors *and* descendants — so
/// the effective column set is unambiguous everywhere. Returns the id of
/// the schema that already defines `name`, if any.
fn find_shadowing_conflict(ctx: &ReducerContext, schema_id: u64, name: &str) -> Option<u64> {
    if SYSTEM_PROPERTY_NAMES.contains(&name) {
        return None;
    }
    let mut related: Vec<u64> = schema_ancestor_chain(ctx, schema_id);
    related.extend(schema_descendants(ctx, schema_id));
    related.retain(|sid| *sid != schema_id);
    related.into_iter().find(|sid| {
        ctx.db
            .property_definition()
            .schema_id()
            .filter(sid)
            .any(|p| p.name == name)
    })
}

// ============================================================
// Schema Reducers
// ============================================================

#[reducer]
pub fn create_database_schema(
    ctx: &ReducerContext,
    page_id: u64,
    name: String,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_page_write(ctx, page_id)?;
    ctx.db.database_schema().insert(DatabaseSchema {
        id: next_database_schema_id(ctx),
        page_id,
        name,
        config: None,
        parent_schema_id: None,
    });
    Ok(())
}

/// Link (or unlink, with `None`) a schema to a parent schema. The child's
/// effective columns become the parent chain's definitions plus its own —
/// see `effective_property_definitions`. Rejects self-parenting, cycles,
/// and links that would shadow a property name anywhere in the combined
/// chain (v1 has no override semantics).
#[reducer]
pub fn set_schema_parent(
    ctx: &ReducerContext,
    schema_id: u64,
    parent_schema_id: Option<u64>,
) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;

    if let Some(parent_id) = parent_schema_id {
        if parent_id == schema_id {
            return Err("A schema cannot inherit from itself".to_string());
        }
        ctx.db
            .database_schema()
            .id()
            .find(parent_id)
            .ok_or("Parent schema not found")?;

        // Cycle guard: the proposed parent's ancestor chain must not pass
        // through this schema (or any of its descendants — equivalent check,
        // since descendants chain through schema_id).
        if schema_ancestor_chain(ctx, parent_id).contains(&schema_id) {
            return Err("Cannot set parent: would create an inheritance cycle".to_string());
        }

        // No-shadowing: every name defined in this schema's subtree must be
        // absent from the new ancestor chain.
        let new_ancestors = schema_ancestor_chain(ctx, parent_id);
        let mut subtree = vec![schema_id];
        subtree.extend(schema_descendants(ctx, schema_id));
        for sid in &subtree {
            for prop in ctx.db.property_definition().schema_id().filter(sid) {
                if SYSTEM_PROPERTY_NAMES.contains(&prop.name.as_str()) {
                    continue;
                }
                let clash = new_ancestors.iter().any(|aid| {
                    ctx.db
                        .property_definition()
                        .schema_id()
                        .filter(aid)
                        .any(|p| p.name == prop.name)
                });
                if clash {
                    return Err(format!(
                        "Cannot set parent: property \"{}\" exists in both the parent chain and this schema's chain",
                        prop.name
                    ));
                }
            }
        }
    }

    ctx.db.database_schema().id().update(DatabaseSchema {
        parent_schema_id,
        ..schema
    });
    Ok(())
}

#[reducer]
pub fn update_database_schema_config(
    ctx: &ReducerContext,
    schema_id: u64,
    config: String,
) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
    let mut schema = ctx
        .db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    schema.config = Some(config);
    ctx.db.database_schema().id().update(schema);
    Ok(())
}

#[reducer]
pub fn add_property(
    ctx: &ReducerContext,
    schema_id: u64,
    name: String,
    property_type: PropertyType,
    config: String,
) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
    ctx.db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Schema not found")?;
    if let Some(other) = find_shadowing_conflict(ctx, schema_id, &name) {
        return Err(format!(
            "Property \"{name}\" already exists on a related schema (id {other}) in this inheritance chain"
        ));
    }
    let max_order = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .map(|p| p.order)
        .max()
        .unwrap_or(0);
    ctx.db.property_definition().insert(PropertyDefinition {
        id: next_property_definition_id(ctx),
        schema_id,
        name,
        property_type,
        config,
        order: max_order + 1,
    });
    Ok(())
}

#[reducer]
pub fn reorder_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    new_order: u32,
) -> Result<(), String> {
    require_property_write(ctx, property_definition_id)?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            order: new_order,
            ..prop
        });
    Ok(())
}

#[reducer]
pub fn delete_property(ctx: &ReducerContext, property_definition_id: u64) -> Result<(), String> {
    require_property_write(ctx, property_definition_id)?;
    ctx.db
        .property_definition()
        .id()
        .delete(property_definition_id);
    Ok(())
}

#[reducer]
pub fn rename_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    name: String,
) -> Result<(), String> {
    require_property_write(ctx, property_definition_id)?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    if name != prop.name {
        if let Some(other) = find_shadowing_conflict(ctx, prop.schema_id, &name) {
            return Err(format!(
                "Property \"{name}\" already exists on a related schema (id {other}) in this inheritance chain"
            ));
        }
    }
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { name, ..prop });
    Ok(())
}

#[reducer]
pub fn update_property_config(
    ctx: &ReducerContext,
    property_definition_id: u64,
    config: String,
) -> Result<(), String> {
    require_property_write(ctx, property_definition_id)?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { config, ..prop });
    Ok(())
}

/// Changing a column's type migrates its stored values (convert-or-clear)
/// instead of orphaning them under a mismatched tag — previously the client
/// rendered such rows as empty (`PropertyCell` matches strictly on the value
/// tag) even though the data was still in the table.
///
/// Rules (mirrored by the change-type preview in `web/src/components/GridView.tsx`
/// — keep the two in sync):
/// - convertible values are rewritten via `set_property_value_inner`, so the
///   normal append-only history row is kept and the change stays undoable
///   through cell History;
/// - unconvertible values are cleared (row deleted); their last history row
///   is retired (`is_current = false`) but kept, so cell History can still
///   restore them;
/// - `Formula` / `Rollup` targets store nothing client-side, so rows are left
///   untouched entirely;
/// - `Select` / `MultiSelect` targets reseed `config.options` from the
///   converted values (previously the config was blanked, orphaning even
///   perfectly good values).
///
/// The whole reducer is one transaction: migration and definition update
/// commit or roll back together.
#[reducer]
pub fn update_property_type(
    ctx: &ReducerContext,
    property_definition_id: u64,
    property_type: PropertyType,
) -> Result<(), String> {
    require_property_write(ctx, property_definition_id)?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(property_definition_id)
        .ok_or("PropertyDefinition not found")?;

    let mut seed_options: Vec<String> = Vec::new();
    if !matches!(
        property_type,
        PropertyType::Formula | PropertyType::Rollup
    ) {
        let mut rows: Vec<PagePropertyValue> = ctx
            .db
            .page_property_value()
            .property_definition_id()
            .filter(&property_definition_id)
            .collect();
        // Deterministic order so seeded select options are stable.
        rows.sort_by_key(|r| (r.page_id, r.id));
        for row in rows {
            // Visually empty cells stay exactly as they are — same display
            // before and after, no history spam, no warning noise.
            if is_empty_property_value(&row.value) {
                continue;
            }
            match convert_property_value(&row.value, &property_type) {
                ConvertOutcome::Keep => {}
                ConvertOutcome::Convert(new_value, mut opts) => {
                    seed_options.append(&mut opts);
                    set_property_value_inner(
                        ctx,
                        row.page_id,
                        property_definition_id,
                        new_value,
                        ActorType::Human,
                    )?;
                }
                ConvertOutcome::Clear => {
                    let stale: Vec<PagePropertyValueHistory> = ctx
                        .db
                        .page_property_value_history()
                        .page_id()
                        .filter(&row.page_id)
                        .filter(|h| {
                            h.property_definition_id == property_definition_id
                                && h.is_current
                        })
                        .collect();
                    for hist in stale {
                        ctx.db.page_property_value_history().id().update(
                            PagePropertyValueHistory {
                                is_current: false,
                                ..hist
                            },
                        );
                    }
                    ctx.db.page_property_value().id().delete(row.id);
                }
            }
        }
    }

    let mut distinct: Vec<String> = Vec::new();
    for o in seed_options {
        if !distinct.contains(&o) {
            distinct.push(o);
        }
    }
    let config = match &property_type {
        PropertyType::Select | PropertyType::MultiSelect if !distinct.is_empty() => {
            serde_json::json!({ "options": distinct }).to_string()
        }
        _ => "{}".to_string(),
    };
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            property_type,
            config,
            ..prop
        });
    Ok(())
}

/// Outcome of converting one stored value to a new column type.
#[derive(Debug, PartialEq)]
enum ConvertOutcome {
    /// Identical value — skip the write (no history spam).
    Keep,
    /// Rewritten value plus select options to seed (non-empty only for
    /// `Select` / `MultiSelect` targets).
    Convert(PropertyValue, Vec<String>),
    /// Cannot be converted — clear the cell (recoverable via history).
    Clear,
}

/// "Visually empty" mirrors the client's `isPropValueEmpty`
/// (`web/src/components/GridView.tsx`): `Number(0)` and `Checkbox(false)`
/// are real values, everything else empty-looking is skipped by migration.
fn is_empty_property_value(value: &PropertyValue) -> bool {
    match value {
        PropertyValue::Text(s) | PropertyValue::Select(s) | PropertyValue::Url(s) => {
            s.trim().is_empty()
        }
        PropertyValue::MultiSelect(v) => v.is_empty(),
        PropertyValue::Relation(v) => v.is_empty(),
        PropertyValue::Date(ms) => *ms == 0,
        PropertyValue::Number(_)
        | PropertyValue::Checkbox(_)
        | PropertyValue::Person(_)
        | PropertyValue::Ai(_)
        | PropertyValue::File(_) => false,
    }
}

/// Format a finite f64 without a trailing `.0` (`720.0` → `"720"`).
fn fmt_number(n: f64) -> String {
    if n.is_finite() && n == n.trunc() && n.abs() < 9e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Parse a numeric string, tolerating the Ukrainian decimal comma.
fn parse_number_text(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<f64>() {
        if n.is_finite() {
            return Some(n);
        }
    }
    if let Ok(n) = t.replace(',', ".").parse::<f64>() {
        if n.is_finite() {
            return Some(n);
        }
    }
    None
}

fn parse_checkbox_text(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "true" | "1" | "yes" | "y" | "так" | "+" | "on" | "checked" => Some(true),
        "false" | "0" | "no" | "n" | "ні" | "-" | "off" | "unchecked" => Some(false),
        _ => None,
    }
}

// Proleptic Gregorian calendar helpers (Howard Hinnant's algorithms) —
// chrono isn't a dependency, and `Date` cells are plain unix-millis u64.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parse `YYYY-MM-DD` (also `YYYY/MM/DD`) into unix millis.
fn parse_iso_date(s: &str) -> Option<u64> {
    let t = s.trim();
    let sep = if t.contains('-') {
        '-'
    } else if t.contains('/') {
        '/'
    } else {
        return None;
    };
    let parts: Vec<&str> = t.split(sep).collect();
    if parts.len() != 3 || parts[0].len() != 4 {
        return None;
    }
    let (y, m, d) = (
        parts[0].parse::<i64>().ok()?,
        parts[1].parse::<i64>().ok()?,
        parts[2].parse::<i64>().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // Roundtrip guard rejects e.g. Feb 30.
    let (ry, rm, rd) = civil_from_days(days);
    if ry != y || rm != m || rd != d {
        return None;
    }
    days.checked_mul(86_400_000).map(|ms| ms as u64)
}

fn format_iso_date(ms: u64) -> String {
    let days = (ms as i64).div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Convert one stored value to the target column type.
/// See the `update_property_type` docs for the contract.
fn convert_property_value(
    value: &PropertyValue,
    target: &PropertyType,
) -> ConvertOutcome {
    use ConvertOutcome::{Clear, Convert, Keep};
    let converted = |v: PropertyValue| Convert(v, Vec::new());
    let with_option = |v: PropertyValue, opt: String| Convert(v, vec![opt]);
    match target {
        PropertyType::Text => match value {
            PropertyValue::Text(_) => Keep,
            PropertyValue::Url(s) | PropertyValue::Select(s) => {
                converted(PropertyValue::Text(s.clone()))
            }
            PropertyValue::Number(n) => converted(PropertyValue::Text(fmt_number(*n))),
            PropertyValue::Checkbox(b) => converted(PropertyValue::Text(b.to_string())),
            PropertyValue::MultiSelect(v) => {
                converted(PropertyValue::Text(v.join(", ")))
            }
            PropertyValue::Date(ms) => {
                converted(PropertyValue::Text(format_iso_date(*ms)))
            }
            PropertyValue::Ai(ai) => {
                converted(PropertyValue::Text(ai.output.clone()))
            }
            PropertyValue::File(files) => converted(PropertyValue::Text(
                files.iter().map(|f| f.name.clone()).collect::<Vec<_>>().join(", "),
            )),
            _ => Clear,
        },
        PropertyType::Number => match value {
            PropertyValue::Number(_) => Keep,
            PropertyValue::Text(s) | PropertyValue::Url(s) | PropertyValue::Select(s) => {
                match parse_number_text(s) {
                    Some(n) => converted(PropertyValue::Number(n)),
                    None => Clear,
                }
            }
            PropertyValue::Checkbox(b) => {
                converted(PropertyValue::Number(if *b { 1.0 } else { 0.0 }))
            }
            PropertyValue::MultiSelect(v) if v.len() == 1 => {
                match parse_number_text(&v[0]) {
                    Some(n) => converted(PropertyValue::Number(n)),
                    None => Clear,
                }
            }
            _ => Clear,
        },
        PropertyType::Checkbox => match value {
            PropertyValue::Checkbox(_) => Keep,
            PropertyValue::Number(n) => converted(PropertyValue::Checkbox(*n != 0.0)),
            PropertyValue::Text(s) | PropertyValue::Select(s) => {
                match parse_checkbox_text(s) {
                    Some(b) => converted(PropertyValue::Checkbox(b)),
                    None => Clear,
                }
            }
            _ => Clear,
        },
        PropertyType::Date => match value {
            PropertyValue::Date(_) => Keep,
            PropertyValue::Text(s) => match parse_iso_date(s) {
                Some(ms) => converted(PropertyValue::Date(ms)),
                None => Clear,
            },
            // Plausible unix-millis range 2000-01-01 .. 2100-01-01.
            PropertyValue::Number(n)
                if *n >= 946_684_800_000.0 && *n <= 4_102_444_800_000.0 =>
            {
                converted(PropertyValue::Date(*n as u64))
            }
            _ => Clear,
        },
        PropertyType::Select => match value {
            PropertyValue::Select(s) if !s.trim().is_empty() => {
                with_option(PropertyValue::Select(s.clone()), s.clone())
            }
            PropertyValue::Text(s) | PropertyValue::Url(s)
                if !s.trim().is_empty() =>
            {
                with_option(PropertyValue::Select(s.clone()), s.clone())
            }
            PropertyValue::Number(n) => {
                let s = fmt_number(*n);
                with_option(PropertyValue::Select(s.clone()), s)
            }
            PropertyValue::Checkbox(b) => {
                let s = b.to_string();
                with_option(PropertyValue::Select(s.clone()), s)
            }
            PropertyValue::Date(ms) => {
                let s = format_iso_date(*ms);
                with_option(PropertyValue::Select(s.clone()), s)
            }
            PropertyValue::MultiSelect(v) if v.len() == 1 && !v[0].trim().is_empty() => {
                with_option(PropertyValue::Select(v[0].clone()), v[0].clone())
            }
            _ => Clear,
        },
        PropertyType::MultiSelect => match value {
            PropertyValue::MultiSelect(v) if !v.is_empty() => {
                Convert(PropertyValue::MultiSelect(v.clone()), v.clone())
            }
            PropertyValue::Select(s) | PropertyValue::Text(s) | PropertyValue::Url(s)
                if !s.trim().is_empty() =>
            {
                with_option(PropertyValue::MultiSelect(vec![s.clone()]), s.clone())
            }
            PropertyValue::Number(n) => {
                let s = fmt_number(*n);
                with_option(PropertyValue::MultiSelect(vec![s.clone()]), s)
            }
            PropertyValue::Checkbox(b) => {
                let s = b.to_string();
                with_option(PropertyValue::MultiSelect(vec![s.clone()]), s)
            }
            PropertyValue::Date(ms) => {
                let s = format_iso_date(*ms);
                with_option(PropertyValue::MultiSelect(vec![s.clone()]), s)
            }
            _ => Clear,
        },
        PropertyType::Url => match value {
            PropertyValue::Url(_) => Keep,
            PropertyValue::Text(s) if !s.trim().is_empty() => {
                converted(PropertyValue::Url(s.clone()))
            }
            _ => Clear,
        },
        PropertyType::Relation => match value {
            PropertyValue::Relation(_) => Keep,
            _ => Clear,
        },
        PropertyType::Person => match value {
            PropertyValue::Person(_) => Keep,
            _ => Clear,
        },
        PropertyType::File => match value {
            PropertyValue::File(_) => Keep,
            _ => Clear,
        },
        PropertyType::Ai => match value {
            PropertyValue::Ai(_) => Keep,
            _ => Clear,
        },
        // Handled by the caller (rows untouched) — unreachable here.
        PropertyType::Formula | PropertyType::Rollup => Keep,
    }
}

/// Seed the agent_instruction PropertyDefinition for a database schema.
/// Idempotent — no-op if the property already exists for this schema.
/// Called for new schemas or as a one-time migration for pre-existing workspaces.
/// Workers call discover_instruction_pages gracefully if this property is absent.
#[reducer]
pub fn seed_agent_instruction_property(ctx: &ReducerContext, schema_id: u64) -> Result<(), String> {
    require_schema_write(ctx, schema_id)?;
    ctx.db
        .database_schema()
        .id()
        .find(schema_id)
        .ok_or("Database schema not found")?;

    let already_exists = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .any(|p| p.name == "agent_instruction");

    if already_exists {
        return Ok(());
    }

    ctx.db.property_definition().insert(PropertyDefinition {
        id: next_property_definition_id(ctx),
        schema_id,
        name: "agent_instruction".to_string(),
        property_type: PropertyType::Checkbox,
        config: "{}".to_string(),
        order: 0,
    });

    Ok(())
}

// ============================================================
// Property Value Reducers
// ============================================================

/// Upserts the current value and appends an immutable history row.
#[reducer]
pub fn set_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    set_property_value_inner(ctx, page_id, property_definition_id, value, ActorType::Human)
}

/// Body of `set_property_value`, minus the sender ACL gate — the live
/// automation executor calls this after checking the rule's `run_as`
/// authority instead, stamping the automation as the changing actor.
pub(crate) fn set_property_value_inner(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
    changed_by: ActorType,
) -> Result<(), String> {
    // Collect existing current-history entries before mutating
    let stale_history: Vec<PagePropertyValueHistory> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
        .collect();

    for hist in stale_history {
        ctx.db
            .page_property_value_history()
            .id()
            .update(PagePropertyValueHistory {
                is_current: false,
                ..hist
            });
    }

    // Append new history entry (clone value — it's also needed for upsert below)
    ctx.db
        .page_property_value_history()
        .insert(PagePropertyValueHistory {
            id: next_page_property_value_history_id(ctx),
            page_id,
            property_definition_id,
            value: value.clone(),
            is_current: true,
            changed_at: ctx.timestamp,
            changed_by,
        });

    // Collect existing current value before mutating
    let existing_value: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    match existing_value {
        Some(existing) => {
            ctx.db
                .page_property_value()
                .id()
                .update(PagePropertyValue { value, ..existing });
        }
        None => {
            ctx.db.page_property_value().insert(PagePropertyValue {
                id: next_page_property_value_id(ctx),
                page_id,
                property_definition_id,
                value,
            });
        }
    }

    Ok(())
}

#[reducer]
pub fn clear_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let existing: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    if let Some(row) = existing {
        ctx.db.page_property_value().id().delete(row.id);
    }
    Ok(())
}

#[cfg(test)]
mod conversion_tests {
    use super::*;

    fn text(s: &str) -> PropertyValue {
        PropertyValue::Text(s.to_string())
    }

    #[test]
    fn text_number_roundtrip() {
        assert_eq!(
            convert_property_value(&text("720"), &PropertyType::Number),
            ConvertOutcome::Convert(PropertyValue::Number(720.0), vec![])
        );
        assert_eq!(
            convert_property_value(&text("12,5"), &PropertyType::Number),
            ConvertOutcome::Convert(PropertyValue::Number(12.5), vec![])
        );
        assert_eq!(
            convert_property_value(&text("abc"), &PropertyType::Number),
            ConvertOutcome::Clear
        );
        assert_eq!(
            convert_property_value(&PropertyValue::Number(720.0), &PropertyType::Text),
            ConvertOutcome::Convert(text("720"), vec![])
        );
        assert_eq!(
            convert_property_value(&PropertyValue::Number(12.5), &PropertyType::Text),
            ConvertOutcome::Convert(text("12.5"), vec![])
        );
    }

    #[test]
    fn same_tag_is_keep() {
        assert_eq!(
            convert_property_value(&text("x"), &PropertyType::Text),
            ConvertOutcome::Keep
        );
        assert_eq!(
            convert_property_value(
                &PropertyValue::Checkbox(true),
                &PropertyType::Checkbox
            ),
            ConvertOutcome::Keep
        );
    }

    #[test]
    fn checkbox_text_sets() {
        for truthy in ["true", "1", "yes", "так", "ON", " + "] {
            assert_eq!(
                convert_property_value(&text(truthy), &PropertyType::Checkbox),
                ConvertOutcome::Convert(PropertyValue::Checkbox(true), vec![]),
                "truthy: {truthy}"
            );
        }
        for falsy in ["false", "0", "no", "ні", "off"] {
            assert_eq!(
                convert_property_value(&text(falsy), &PropertyType::Checkbox),
                ConvertOutcome::Convert(PropertyValue::Checkbox(false), vec![]),
                "falsy: {falsy}"
            );
        }
        assert_eq!(
            convert_property_value(&text("maybe"), &PropertyType::Checkbox),
            ConvertOutcome::Clear
        );
    }

    #[test]
    fn iso_date_roundtrip_and_rejects() {
        assert_eq!(parse_iso_date("2026-03-15"), Some(1_773_532_800_000));
        assert_eq!(format_iso_date(1_773_532_800_000), "2026-03-15");
        assert_eq!(parse_iso_date("2026/03/15"), Some(1_773_532_800_000));
        assert_eq!(parse_iso_date("2026-02-30"), None);
        assert_eq!(parse_iso_date("15.03.2026"), None);
        assert_eq!(parse_iso_date("hello"), None);
        assert_eq!(
            convert_property_value(&text("2026-03-15"), &PropertyType::Date),
            ConvertOutcome::Convert(PropertyValue::Date(1_773_532_800_000), vec![])
        );
        assert_eq!(
            convert_property_value(&text("hello"), &PropertyType::Date),
            ConvertOutcome::Clear
        );
    }

    #[test]
    fn select_seeds_options() {
        assert_eq!(
            convert_property_value(&text("Todo"), &PropertyType::Select),
            ConvertOutcome::Convert(
                PropertyValue::Select("Todo".to_string()),
                vec!["Todo".to_string()]
            )
        );
        assert_eq!(
            convert_property_value(&text("x"), &PropertyType::Relation),
            ConvertOutcome::Clear
        );
    }

    #[test]
    fn empty_matches_client() {
        assert!(is_empty_property_value(&text("   ")));
        assert!(is_empty_property_value(&PropertyValue::Select(String::new())));
        assert!(is_empty_property_value(&PropertyValue::MultiSelect(vec![])));
        assert!(is_empty_property_value(&PropertyValue::Relation(vec![])));
        assert!(is_empty_property_value(&PropertyValue::Date(0)));
        assert!(!is_empty_property_value(&PropertyValue::Number(0.0)));
        assert!(!is_empty_property_value(&PropertyValue::Checkbox(false)));
        assert!(!is_empty_property_value(&PropertyValue::Person(vec![])));
    }
}
