//! Shared JSON decode helpers for the snapshot importer ([`super::pear_v2`]).
//!
//! Snapshot rows arrive in the web client's encoding: camelCase keys (the TS
//! SDK's field names), `__pear`-tagged wrappers for bigints / identities /
//! timestamps / bytes, and enums as `{tag: "Variant"}` (or `{tag, value}` for
//! payload-carrying variants).

use crate::{
    ActorType, ApiEndpoint, ApiEndpointKey, ApiFieldMapping, Attachment, BlockAccessRule,
    DatabaseSchema, DatabaseView, HttpMethod, PageAccessRule, PageContent, PagePropertyValue,
    PagePropertyValueHistory, PageSnapshot, PageType, PageYjsState, Permission, Principal,
    PropertyDefinition, PropertyType, PropertyValue, SnapshotType, User, UserPreference, ViewType,
    WorkspaceSetting,
};
use serde_json::Value;
use spacetimedb::{Identity, Timestamp};

// ── Generic value helpers ─────────────────────────────────────────────────────

pub(super) fn obj<'a>(
    v: &'a Value,
    ctx: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{ctx}: expected object"))
}

pub(super) fn u64_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<u64, String> {
    decode_u64(m.get(key).ok_or_else(|| format!("missing {key}"))?)
}

pub(super) fn opt_u64_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_u64(v)?)),
    }
}

pub(super) fn string_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    m.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing or invalid string {key}"))
}

pub(super) fn opt_string_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| format!("invalid optional string {key}")),
    }
}

pub(super) fn bool_at(m: &serde_json::Map<String, Value>, key: &str) -> Result<bool, String> {
    m.get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("missing bool {key}"))
}

pub(super) fn bool_at_or(m: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
    m.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub(super) fn decode_u64(v: &Value) -> Result<u64, String> {
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| format!("u64: {e}"));
    }
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bigint") {
            let s = o.get("v").and_then(|x| x.as_str()).ok_or("bigint.v")?;
            return s.parse().map_err(|e| format!("bigint: {e}"));
        }
    }
    Err("expected u64".into())
}

pub(super) fn decode_i64(v: &Value) -> Result<i64, String> {
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    if let Some(n) = v.as_u64() {
        return Ok(n as i64);
    }
    if let Some(s) = v.as_str() {
        return s.parse().map_err(|e| format!("i64: {e}"));
    }
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bigint") {
            let s = o.get("v").and_then(|x| x.as_str()).ok_or("bigint.v")?;
            return s.parse().map_err(|e| format!("bigint: {e}"));
        }
    }
    Err("expected i64".into())
}

pub(super) fn decode_identity(v: &Value) -> Result<Identity, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("identity") {
            let hex_str = o.get("v").and_then(|x| x.as_str()).ok_or("identity.v")?;
            return identity_from_hex(hex_str);
        }
    }
    Err("expected identity".into())
}

pub(super) fn identity_from_hex(hex_str: &str) -> Result<Identity, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("identity hex: {e}"))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "identity must be 32 bytes")?;
    Ok(Identity::from_byte_array(arr))
}

pub(super) fn decode_timestamp(v: &Value) -> Result<Timestamp, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("timestamp") {
            let micros = decode_i64(o.get("v").ok_or("timestamp.v")?)?;
            return Ok(Timestamp::from_micros_since_unix_epoch(micros));
        }
        if let Some(m) = o.get("microsSinceUnixEpoch") {
            return Ok(Timestamp::from_micros_since_unix_epoch(decode_i64(m)?));
        }
    }
    Err("expected timestamp".into())
}

pub(super) fn opt_timestamp_at(
    m: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<Timestamp>, String> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(decode_timestamp(v)?)),
    }
}

pub(super) fn decode_bytes(v: &Value) -> Result<Vec<u8>, String> {
    if let Some(o) = v.as_object() {
        if o.get("__pear").and_then(|x| x.as_str()) == Some("bytes") {
            let b64 = o.get("v").and_then(|x| x.as_str()).ok_or("bytes.v")?;
            return base64_decode(b64);
        }
    }
    Err("expected bytes".into())
}

pub(super) fn base64_decode(b64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64: {e}"))
}

pub(super) fn decode_enum_tag2<T: Clone>(
    v: &Value,
    variants: &[(&str, T)],
    _name: &str,
) -> Result<T, String> {
    if let Some(s) = v.as_str() {
        for (k, t) in variants {
            if *k == s {
                return Ok(t.clone());
            }
        }
    }
    if let Some(o) = v.as_object() {
        let tag = o.get("tag").and_then(|t| t.as_str());
        if let Some(tag) = tag {
            for (k, t) in variants {
                if *k == tag {
                    return Ok(t.clone());
                }
            }
        }
    }
    Err("unknown enum variant".into())
}

// ── Shared semantic decoders ──────────────────────────────────────────────────

pub(super) fn decode_actor_type(v: &Value) -> Result<ActorType, String> {
    if let Some(s) = v.as_str() {
        return match s {
            "Human" => Ok(ActorType::Human),
            _ => Err(format!("ActorType: {s}")),
        };
    }
    let o = v.as_object().ok_or("ActorType")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("ActorType.tag")?;
    match tag {
        "Human" => Ok(ActorType::Human),
        "Agent" => {
            let inner = o
                .get("value")
                .or_else(|| o.get("agent"))
                .and_then(|x| x.as_str())
                .ok_or("Agent.value")?;
            Ok(ActorType::Agent(inner.to_string()))
        }
        _ => Err(format!("ActorType::{tag}")),
    }
}

pub(super) fn decode_principal(v: &Value) -> Result<Principal, String> {
    let o = v.as_object().ok_or("Principal")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("Principal.tag")?;
    match tag {
        "WorkspaceMember" => Ok(Principal::WorkspaceMember(decode_identity(
            o.get("value").ok_or("WorkspaceMember.value")?,
        )?)),
        _ => Err(format!("Principal::{tag}")),
    }
}

pub(super) fn decode_permission(v: &Value) -> Result<Permission, String> {
    decode_enum_tag2(
        v,
        &[("Read", Permission::Read), ("Write", Permission::Write)],
        "Permission",
    )
}

pub(super) fn decode_page_type(v: &Value) -> Result<PageType, String> {
    decode_enum_tag2(
        v,
        &[("Doc", PageType::Doc), ("Database", PageType::Database)],
        "PageType",
    )
}


pub(super) fn decode_http_method(v: &Value) -> Result<HttpMethod, String> {
    decode_enum_tag2(
        v,
        &[
            ("Get", HttpMethod::Get),
            ("Post", HttpMethod::Post),
            ("Patch", HttpMethod::Patch),
            ("Delete", HttpMethod::Delete),
        ],
        "HttpMethod",
    )
}

pub(super) fn decode_http_method_vec(v: &Value) -> Result<Vec<HttpMethod>, String> {
    let arr = v.as_array().ok_or("allowedMethods: expected array")?;
    arr.iter().map(decode_http_method).collect()
}

pub(super) fn decode_property_value(v: &Value) -> Result<PropertyValue, String> {
    let o = v.as_object().ok_or("PropertyValue")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("PropertyValue.tag")?;
    match tag {
        "Text" => Ok(PropertyValue::Text(string_at(o, "value")?)),
        "Number" => Ok(PropertyValue::Number(
            o.get("value").and_then(|x| x.as_f64()).ok_or("Number")?,
        )),
        "Date" => Ok(PropertyValue::Date(u64_at(o, "value")?)),
        "Select" => Ok(PropertyValue::Select(string_at(o, "value")?)),
        "MultiSelect" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("MultiSelect")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(x.as_str().ok_or("ms")?.to_string());
            }
            Ok(PropertyValue::MultiSelect(xs))
        }
        "Relation" => {
            let arr = o
                .get("value")
                .and_then(|v| v.as_array())
                .ok_or("Relation")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(decode_u64(x)?);
            }
            Ok(PropertyValue::Relation(xs))
        }
        "Checkbox" => Ok(PropertyValue::Checkbox(
            o.get("value")
                .and_then(|x| x.as_bool())
                .ok_or("Checkbox.value")?,
        )),
        "Url" => Ok(PropertyValue::Url(string_at(o, "value")?)),
        "Person" => {
            let arr = o.get("value").and_then(|v| v.as_array()).ok_or("Person")?;
            let mut xs = Vec::new();
            for x in arr {
                xs.push(x.as_str().ok_or("person id")?.to_string());
            }
            Ok(PropertyValue::Person(xs))
        }
        "File" => {
            let arr = o.get("value").and_then(Value::as_array).ok_or("File.value")?;
            let refs = arr.iter().map(|value| {
                let file = obj(value, "File entry")?;
                Ok(crate::FileRef {
                    name: string_at(file, "name")?,
                    object_id: string_at(file, "objectId")?,
                    external_url: string_at(file, "externalUrl")?,
                })
            }).collect::<Result<Vec<_>, String>>()?;
            Ok(PropertyValue::File(refs))
        }
        "Ai" => {
            let value = obj(o.get("value").ok_or("Ai.value")?, "Ai.value")?;
            Ok(PropertyValue::Ai(crate::AiPropertyValue {
                output: string_at(value, "output")?,
                evaluation_id: u64_at(value, "evaluationId")?,
                is_stale: bool_at(value, "isStale")?,
            }))
        }
        _ => Err(format!("PropertyValue::{tag}")),
    }
}

// ── Shared row decoders (identical between v1 and v2) ────────────────────────

pub(super) fn decode_user(v: &Value) -> Result<User, String> {
    let m = obj(v, "user")?;
    Ok(User {
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        name: string_at(m, "name")?,
        email: string_at(m, "email")?,
        is_authenticated: bool_at(m, "isAuthenticated")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        last_seen_at: decode_timestamp(m.get("lastSeenAt").ok_or("lastSeenAt")?)?,
        // Optional in older snapshots — defaults to non-admin so an import
        // never silently grants admin rights. Workspace owner can promote
        // post-import via `set_user_admin`.
        is_admin: m
            .get("isAdmin")
            .and_then(|_| bool_at(m, "isAdmin").ok())
            .unwrap_or(false),
    })
}

pub(super) fn decode_user_preference(v: &Value) -> Result<UserPreference, String> {
    let m = obj(v, "user_preference")?;
    Ok(UserPreference {
        id: u64_at(m, "id")?,
        identity: decode_identity(m.get("identity").ok_or("identity")?)?,
        key: string_at(m, "key")?,
        value_json: string_at(m, "valueJson")?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_workspace_setting(v: &Value) -> Result<WorkspaceSetting, String> {
    let m = obj(v, "workspace_setting")?;
    Ok(WorkspaceSetting {
        id: u64_at(m, "id")?,
        key: string_at(m, "key")?,
        value_json: string_at(m, "valueJson")?,
        updated_by: decode_identity(m.get("updatedBy").ok_or("updatedBy")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_page_content(v: &Value) -> Result<PageContent, String> {
    let m = obj(v, "page_content")?;
    Ok(PageContent {
        page_id: u64_at(m, "pageId")?,
        content: string_at(m, "content")?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_page_yjs_state(v: &Value) -> Result<PageYjsState, String> {
    let m = obj(v, "page_yjs_state")?;
    Ok(PageYjsState {
        page_id: u64_at(m, "pageId")?,
        data: decode_bytes(m.get("data").ok_or("data")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_database_schema(v: &Value) -> Result<DatabaseSchema, String> {
    let m = obj(v, "database_schema")?;
    Ok(DatabaseSchema {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        name: string_at(m, "name")?,
        config: opt_string_at(m, "config")?,
        parent_schema_id: opt_u64_at(m, "parentSchemaId")?,
    })
}

pub(super) fn decode_property_definition(v: &Value) -> Result<PropertyDefinition, String> {
    let m = obj(v, "property_definition")?;
    Ok(PropertyDefinition {
        id: u64_at(m, "id")?,
        schema_id: u64_at(m, "schemaId")?,
        name: string_at(m, "name")?,
        property_type: decode_property_type(m.get("propertyType").ok_or("propertyType")?)?,
        config: string_at(m, "config")?,
        order: u64_at(m, "order")? as u32,
    })
}

pub(super) fn decode_property_type(v: &Value) -> Result<PropertyType, String> {
    let o = v.as_object().ok_or("PropertyType")?;
    let tag = o
        .get("tag")
        .and_then(|t| t.as_str())
        .ok_or("PropertyType.tag")?;
    match tag {
        "Text" => Ok(PropertyType::Text),
        "Number" => Ok(PropertyType::Number),
        "Date" => Ok(PropertyType::Date),
        "Select" => Ok(PropertyType::Select),
        "MultiSelect" => Ok(PropertyType::MultiSelect),
        "Relation" => Ok(PropertyType::Relation),
        "Checkbox" => Ok(PropertyType::Checkbox),
        "Url" => Ok(PropertyType::Url),
        "Person" => Ok(PropertyType::Person),
        "Ai" => Ok(PropertyType::Ai),
        "Formula" => Ok(PropertyType::Formula),
        "Rollup" => Ok(PropertyType::Rollup),
        "File" => Ok(PropertyType::File),
        _ => Err(format!("PropertyType::{tag}")),
    }
}

pub(super) fn decode_database_view(v: &Value) -> Result<DatabaseView, String> {
    let m = obj(v, "database_view")?;
    Ok(DatabaseView {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        name: string_at(m, "name")?,
        view_type: decode_view_type(m.get("viewType").ok_or("viewType")?)?,
        config: string_at(m, "config")?,
        is_default: bool_at(m, "isDefault")?,
        owner_identity: opt_string_at(m, "ownerIdentity")?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_view_type(v: &Value) -> Result<ViewType, String> {
    decode_enum_tag2(
        v,
        &[
            ("Grid", ViewType::Grid),
            ("List", ViewType::List),
            ("Kanban", ViewType::Kanban),
            ("Calendar", ViewType::Calendar),
            ("Gallery", ViewType::Gallery),
        ],
        "ViewType",
    )
}

pub(super) fn decode_page_property_value(v: &Value) -> Result<PagePropertyValue, String> {
    let m = obj(v, "page_property_value")?;
    Ok(PagePropertyValue {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        value: decode_property_value(m.get("value").ok_or("value")?)?,
    })
}

pub(super) fn decode_page_property_value_history(
    v: &Value,
) -> Result<PagePropertyValueHistory, String> {
    let m = obj(v, "page_property_value_history")?;
    Ok(PagePropertyValueHistory {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        value: decode_property_value(m.get("value").ok_or("value")?)?,
        is_current: bool_at(m, "isCurrent")?,
        changed_at: decode_timestamp(m.get("changedAt").ok_or("changedAt")?)?,
        changed_by: decode_actor_type(m.get("changedBy").ok_or("changedBy")?)?,
    })
}

pub(super) fn decode_page_snapshot(v: &Value) -> Result<PageSnapshot, String> {
    let m = obj(v, "page_snapshot")?;
    Ok(PageSnapshot {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        title: string_at(m, "title")?,
        content: string_at(m, "content")?,
        snapshot_at: decode_timestamp(m.get("snapshotAt").ok_or("snapshotAt")?)?,
        created_by: decode_actor_type(m.get("createdBy").ok_or("createdBy")?)?,
        snapshot_type: decode_snapshot_type(m.get("snapshotType").ok_or("snapshotType")?)?,
    })
}

pub(super) fn decode_snapshot_type(v: &Value) -> Result<SnapshotType, String> {
    decode_enum_tag2(
        v,
        &[
            ("Manual", SnapshotType::Manual),
            ("Periodic", SnapshotType::Periodic),
            ("PreAgentEdit", SnapshotType::PreAgentEdit),
            ("PostAgentEdit", SnapshotType::PostAgentEdit),
        ],
        "SnapshotType",
    )
}

pub(super) fn decode_attachment(v: &Value) -> Result<Attachment, String> {
    let m = obj(v, "attachment")?;
    Ok(Attachment {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        filename: string_at(m, "filename")?,
        content_type: string_at(m, "contentType")?,
        storage_key: string_at(m, "storageKey")?,
        size_bytes: u64_at(m, "sizeBytes")?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
    })
}

pub(super) fn decode_page_access_rule(v: &Value) -> Result<PageAccessRule, String> {
    let m = obj(v, "page_access_rule")?;
    Ok(PageAccessRule {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        principal: decode_principal(m.get("principal").ok_or("principal")?)?,
        permission: decode_permission(m.get("permission").ok_or("permission")?)?,
        granted_by: decode_identity(m.get("grantedBy").ok_or("grantedBy")?)?,
        granted_at: decode_timestamp(m.get("grantedAt").ok_or("grantedAt")?)?,
    })
}

pub(super) fn decode_block_access_rule(v: &Value) -> Result<BlockAccessRule, String> {
    let m = obj(v, "block_access_rule")?;
    Ok(BlockAccessRule {
        id: u64_at(m, "id")?,
        page_id: u64_at(m, "pageId")?,
        block_id: string_at(m, "blockId")?,
        principal: decode_principal(m.get("principal").ok_or("principal")?)?,
        permission: decode_permission(m.get("permission").ok_or("permission")?)?,
        granted_by: decode_identity(m.get("grantedBy").ok_or("grantedBy")?)?,
        granted_at: decode_timestamp(m.get("grantedAt").ok_or("grantedAt")?)?,
    })
}






















pub(super) fn decode_api_endpoint(v: &Value) -> Result<ApiEndpoint, String> {
    let m = obj(v, "api_endpoint")?;
    Ok(ApiEndpoint {
        id: u64_at(m, "id")?,
        database_page_id: u64_at(m, "databasePageId")?,
        slug: string_at(m, "slug")?,
        display_name: string_at(m, "displayName")?,
        description: string_at(m, "description")?,
        allowed_methods: decode_http_method_vec(m.get("allowedMethods").ok_or("allowedMethods")?)?,
        require_auth: bool_at(m, "requireAuth")?,
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        updated_at: decode_timestamp(m.get("updatedAt").ok_or("updatedAt")?)?,
    })
}

pub(super) fn decode_api_field_mapping(v: &Value) -> Result<ApiFieldMapping, String> {
    let m = obj(v, "api_field_mapping")?;
    Ok(ApiFieldMapping {
        id: u64_at(m, "id")?,
        endpoint_id: u64_at(m, "endpointId")?,
        property_definition_id: u64_at(m, "propertyDefinitionId")?,
        field_name: string_at(m, "fieldName")?,
        required_on_create: bool_at(m, "requiredOnCreate")?,
        default_value: opt_string_at(m, "defaultValue")?,
        read_only: bool_at(m, "readOnly")?,
        field_order: u64_at(m, "fieldOrder")? as u32,
    })
}

pub(super) fn decode_api_endpoint_key(v: &Value) -> Result<ApiEndpointKey, String> {
    let m = obj(v, "api_endpoint_key")?;
    Ok(ApiEndpointKey {
        id: u64_at(m, "id")?,
        endpoint_id: u64_at(m, "endpointId")?,
        key_hash: string_at(m, "keyHash")?,
        label: string_at(m, "label")?,
        allowed_methods: decode_http_method_vec(m.get("allowedMethods").ok_or("allowedMethods")?)?,
        created_by: decode_identity(m.get("createdBy").ok_or("createdBy")?)?,
        created_at: decode_timestamp(m.get("createdAt").ok_or("createdAt")?)?,
        last_used_at: opt_timestamp_at(m, "lastUsedAt")?,
        expires_at: opt_timestamp_at(m, "expiresAt")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_file_values_preserve_blob_and_external_references() {
        let value = json!({"tag": "File", "value": [
            {"name": "photo.png", "objectId": "blob-123", "externalUrl": ""},
            {"name": "manual.pdf", "objectId": "", "externalUrl": "https://example.com/manual.pdf"}
        ]});
        assert_eq!(decode_property_value(&value).unwrap(), PropertyValue::File(vec![
            crate::FileRef { name: "photo.png".into(), object_id: "blob-123".into(), external_url: "".into() },
            crate::FileRef { name: "manual.pdf".into(), object_id: "".into(), external_url: "https://example.com/manual.pdf".into() },
        ]));
        assert_eq!(decode_property_value(&json!({"tag": "File", "value": []})).unwrap(), PropertyValue::File(vec![]));
        let mut invalid = value.clone();
        invalid["value"][0].as_object_mut().unwrap().remove("objectId");
        assert!(decode_property_value(&invalid).is_err());
    }

    #[test]
    fn snapshot_ai_values_preserve_output_and_provenance() {
        let value = json!({"tag": "Ai", "value": {
            "output": "classified", "evaluationId": {"__pear": "bigint", "v": "9007199254740993"}, "isStale": true
        }});
        assert_eq!(decode_property_value(&value).unwrap(), PropertyValue::Ai(crate::AiPropertyValue {
            output: "classified".into(), evaluation_id: 9007199254740993, is_stale: true,
        }));
        let mut invalid = value;
        invalid["value"]["isStale"] = Value::Null;
        assert!(decode_property_value(&invalid).is_err());
    }

    #[test]
    fn snapshot_property_types_include_file_and_computed_columns() {
        for (tag, expected) in [
            ("File", PropertyType::File), ("Ai", PropertyType::Ai),
            ("Formula", PropertyType::Formula), ("Rollup", PropertyType::Rollup),
        ] {
            assert_eq!(decode_property_type(&json!({"tag": tag})).unwrap(), expected);
        }
        assert!(decode_property_type(&json!({"tag": "Unknown"})).is_err());
    }
}
