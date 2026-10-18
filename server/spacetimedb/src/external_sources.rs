//! Provider-independent HTTP data sources. Networking stays in the web service;
//! reducers own configuration, credentials, row links and atomic mapped writes.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use spacetimedb::{reducer, table, ReducerContext, Table};

use crate::access_control::helpers::require_page_write;
use crate::auth::{
    next_workspace_setting_id, sender_is_admin, workspace_setting, WorkspaceSetting,
};
use crate::module_install::sender_is_module_publisher;
use crate::pages::schemas::{
    clear_property_value, database_schema, next_property_definition_id, page_property_value,
    property_definition, set_property_value_inner, DatabaseSchema, PropertyDefinition,
    PropertyType, PropertyValue,
};
use crate::pages::{page, ActorType};

// Credentials are never synced to clients, emitted by status endpoints or
// included in workspace JSON exports. The database owner supplies them to HTTP.
#[table(accessor = external_source_secret, private)]
pub struct ExternalSourceSecret {
    #[primary_key]
    pub database_id: u64,
    pub secret: String,
}

pub const SOURCE_PREFIX: &str = "external-source.";

#[table(accessor = shared_external_source_secret, private)]
pub struct SharedExternalSourceSecret {
    #[primary_key]
    pub source_id: String,
    pub secret: String,
    pub scope: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mapping {
    source_path: String,
    target_property_id: String,
    target_type: String,
    transform: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceConfig {
    enabled: bool,
    name: String,
    base_url: String,
    search_path: String,
    query_param: String,
    results_path: String,
    detail_path: String,
    detail_result_path: String,
    id_path: String,
    label_path: String,
    subtitle_path: String,
    image_path: String,
    auth_header: String,
    auth_prefix: String,
    link_property_id: String,
    mappings: Vec<Mapping>,
    sync_interval_seconds: u64,
    fill_empty_title: bool,
    #[serde(default)]
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
}

fn schema_for(ctx: &ReducerContext, database_id: u64) -> Result<DatabaseSchema, String> {
    ctx.db
        .database_schema()
        .page_id()
        .filter(database_id)
        .next()
        .ok_or("Database schema not found".into())
}

fn config_for(schema: &DatabaseSchema, allow_disabled: bool) -> Result<SourceConfig, String> {
    let config: Value = serde_json::from_str(schema.config.as_deref().unwrap_or("{}"))
        .map_err(|_| "Invalid database configuration")?;
    let source: SourceConfig = serde_json::from_value(config["externalSource"].clone())
        .map_err(|_| "External source is not configured")?;
    if !source.enabled && !allow_disabled {
        return Err("External source is disabled".into());
    }
    Ok(source)
}

fn supported_type(kind: &PropertyType) -> Option<&'static str> {
    Some(match kind {
        PropertyType::Text => "Text",
        PropertyType::Url => "Url",
        PropertyType::Number => "Number",
        PropertyType::Checkbox => "Checkbox",
        PropertyType::Date => "Date",
        PropertyType::Duration => "Duration",
        PropertyType::Select => "Select",
        PropertyType::MultiSelect => "MultiSelect",
        _ => return None,
    })
}

#[reducer]
pub fn configure_external_source(
    ctx: &ReducerContext,
    database_id: u64,
    config_json: String,
    secret: Option<String>,
) -> Result<(), String> {
    // URLs may intentionally reach other services on the private Docker network.
    // Only administrators/publisher can configure networking or credentials.
    if !sender_is_admin(ctx) && !sender_is_module_publisher(ctx) {
        return Err("Only a workspace admin may configure external data sources".into());
    }
    require_page_write(ctx, database_id)?;
    if config_json.len() > 32768
        || secret
            .as_ref()
            .is_some_and(|s| s.len() > 8192 || s.contains(['\r', '\n']))
    {
        return Err("Source configuration too large".into());
    }
    let mut schema = schema_for(ctx, database_id)?;
    let mut config: Value = serde_json::from_str(schema.config.as_deref().unwrap_or("{}"))
        .map_err(|_| "Invalid database configuration")?;
    if !config.is_object() {
        return Err("Database configuration must be an object".into());
    }
    let mut source: SourceConfig =
        serde_json::from_str(&config_json).map_err(|_| "Invalid source configuration")?;
    if let Some(id) = source.source_id.clone() {
        source = bind_shared(shared_config(ctx, &id)?, &source);
        if secret.is_some() {
            return Err("Edit the credential in workspace Data sources".into());
        }
    }
    validate_source(&source)?;
    if source.link_property_id.is_empty() {
        let defs: Vec<_> = ctx
            .db
            .property_definition()
            .schema_id()
            .filter(schema.id)
            .collect();
        let mut name = "External record".to_string();
        let mut suffix = 2;
        while defs.iter().any(|p| p.name == name) {
            name = format!("External record {suffix}");
            suffix += 1;
        }
        source.link_property_id = ctx
            .db
            .property_definition()
            .insert(PropertyDefinition {
                id: next_property_definition_id(ctx),
                schema_id: schema.id,
                name,
                property_type: PropertyType::Text,
                config: "{}".into(),
                order: defs.iter().map(|p| p.order).max().unwrap_or(0) + 1,
            })
            .id
            .to_string();
    }
    let link_id: u64 = source
        .link_property_id
        .parse()
        .map_err(|_| "Invalid link column")?;
    let mut link = ctx
        .db
        .property_definition()
        .id()
        .find(link_id)
        .ok_or("Link column not found")?;
    if link.schema_id != schema.id || link.property_type != PropertyType::Text {
        return Err("Link column must be a Text column in this database".into());
    }
    let mut used = std::collections::HashSet::from([link_id]);
    for mapping in &source.mappings {
        let id: u64 = mapping
            .target_property_id
            .parse()
            .map_err(|_| "Invalid target column")?;
        let prop = ctx
            .db
            .property_definition()
            .id()
            .find(id)
            .ok_or("Target column not found")?;
        if prop.schema_id != schema.id
            || supported_type(&prop.property_type) != Some(mapping.target_type.as_str())
            || !used.insert(id)
            || mapping.source_path.is_empty()
        {
            return Err(
                "Choose separate, compatible columns from this database for each field".into(),
            );
        }
        if ![
            "identity",
            "secondsToMinutes",
            "millisecondsToMinutes",
            "hoursToMinutes",
            "isoDateToMillis",
            "unixSecondsToMillis",
        ]
        .contains(&mapping.transform.as_str())
        {
            return Err("Unknown field transform".into());
        }
    }
    // Remove the picker marker from the previous column when remapped.
    if let Some(old_id) = config["externalSource"]["linkPropertyId"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
    {
        if old_id != link_id {
            if let Some(mut old) = ctx.db.property_definition().id().find(old_id) {
                if old.schema_id == schema.id {
                    if let Ok(Value::Object(mut old_config)) =
                        serde_json::from_str::<Value>(&old.config)
                    {
                        old_config.remove("externalSource");
                        old.config = Value::Object(old_config).to_string();
                        ctx.db.property_definition().id().update(old);
                    }
                }
            }
        }
    }
    let mut link_config: Value = serde_json::from_str(&link.config).unwrap_or(json!({}));
    if !link_config.is_object() {
        return Err("Link column config must be an object".into());
    }
    link_config["externalSource"] = json!(true);
    link.config = link_config.to_string();
    ctx.db.property_definition().id().update(link);
    if let Some(id) = &source.source_id {
        if source.enabled
            && !source.auth_header.is_empty()
            && ctx
                .db
                .shared_external_source_secret()
                .source_id()
                .find(id)
                .is_none_or(|s| s.secret.is_empty() || s.scope != credential_scope(&source))
        {
            return Err("Enter a credential in workspace Data sources".into());
        }
        let previous = config
            .get("externalSource")
            .and_then(|v| v.get("sourceId"))
            .and_then(Value::as_str);
        if previous != Some(id.as_str())
            && config.get("externalSource").is_some()
            && ctx.db.page_property_value().iter().any(|v| {
                v.property_definition_id == link_id
                    && matches!(v.value, PropertyValue::Text(ref raw) if !raw.is_empty())
            })
        {
            return Err("Make this connection reusable first, or unlink existing records before switching sources".into());
        }
        ctx.db
            .external_source_secret()
            .database_id()
            .delete(database_id);
    } else {
        let old_source = config.get("externalSource");
        if !source.auth_header.is_empty()
            && secret.is_none()
            && old_source.is_some_and(|old| {
                old.get("sourceId").and_then(Value::as_str).is_some()
                    || old["baseUrl"].as_str() != Some(source.base_url.as_str())
                    || old["authHeader"].as_str() != Some(source.auth_header.as_str())
            })
        {
            return Err(
                "Re-enter the credential when changing the source URL or auth header".into(),
            );
        }
        if source.auth_header.is_empty() {
            ctx.db
                .external_source_secret()
                .database_id()
                .delete(database_id);
        } else if let Some(secret) = secret {
            let row = ExternalSourceSecret {
                database_id,
                secret,
            };
            if ctx
                .db
                .external_source_secret()
                .database_id()
                .find(database_id)
                .is_some()
            {
                ctx.db.external_source_secret().database_id().update(row);
            } else {
                ctx.db.external_source_secret().insert(row);
            }
        }
        if source.enabled
            && !source.auth_header.is_empty()
            && ctx
                .db
                .external_source_secret()
                .database_id()
                .find(database_id)
                .is_none_or(|s| s.secret.is_empty())
        {
            return Err("Enter a credential for this authenticated source".into());
        }
    }
    source.revision = ctx
        .timestamp
        .to_duration_since_unix_epoch()
        .unwrap_or_default()
        .as_micros()
        .to_string();
    config["externalSource"] = serde_json::to_value(source).map_err(|_| "Invalid source")?;
    schema.config = Some(config.to_string());
    ctx.db.database_schema().id().update(schema);
    Ok(())
}

fn validate_source(source: &SourceConfig) -> Result<(), String> {
    if source.name.trim().is_empty() || source.name.len() > 200 {
        return Err("Source needs a name".into());
    }
    if !(source.base_url.starts_with("https://") || source.base_url.starts_with("http://"))
        || source.base_url.contains(['\r', '\n', '@', '#', '?'])
    {
        return Err("Source URL must be HTTP(S), without credentials, query or fragment".into());
    }
    for path in [&source.search_path, &source.detail_path] {
        if !path.starts_with('/') || path.starts_with("//") || path.contains(['\r', '\n', '#']) {
            return Err("API paths must start with a single slash".into());
        }
    }
    if !source.detail_path.contains("{id}")
        || source.id_path.is_empty()
        || source.label_path.is_empty()
        || source.query_param.is_empty()
        || source.mappings.len() > 32
    {
        return Err(
            "Specify id/label fields, search parameter, and a detail path with {id}".into(),
        );
    }
    if source.auth_header.len() > 100
        || !source
            .auth_header
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || source.auth_prefix.contains(['\r', '\n'])
    {
        return Err("Invalid authorization header".into());
    }
    if !(60..=86400).contains(&source.sync_interval_seconds) {
        return Err("Sync interval must be 60–86400 seconds".into());
    }
    Ok(())
}

fn require_source_admin(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) && !sender_is_module_publisher(ctx) {
        return Err("Only a workspace admin may configure external data sources".into());
    }
    Ok(())
}

fn credential_scope(source: &SourceConfig) -> String {
    serde_json::to_string(&json!([
        source.base_url,
        source.auth_header,
        source.auth_prefix
    ]))
    .unwrap()
}

fn shared_config(ctx: &ReducerContext, id: &str) -> Result<SourceConfig, String> {
    let row = ctx
        .db
        .workspace_setting()
        .key()
        .find(format!("{SOURCE_PREFIX}{id}"))
        .ok_or("Workspace source not found")?;
    serde_json::from_str(&row.value_json).map_err(|_| "Invalid workspace source".into())
}

fn bind_shared(mut shared: SourceConfig, binding: &SourceConfig) -> SourceConfig {
    shared.enabled = binding.enabled;
    shared.link_property_id = binding.link_property_id.clone();
    shared.mappings = binding.mappings.clone();
    shared.sync_interval_seconds = binding.sync_interval_seconds;
    shared.fill_empty_title = binding.fill_empty_title;
    shared
}

#[reducer]
pub fn save_shared_external_source(
    ctx: &ReducerContext,
    source_id: String,
    config_json: String,
    secret: Option<String>,
    import_database_id: Option<u64>,
) -> Result<(), String> {
    require_source_admin(ctx)?;
    if source_id.is_empty()
        || source_id.len() > 100
        || !source_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || config_json.len() > 32768
        || secret
            .as_ref()
            .is_some_and(|s| s.len() > 8192 || s.contains(['\r', '\n']))
    {
        return Err("Invalid workspace source".into());
    }
    let key = format!("{SOURCE_PREFIX}{source_id}");
    let existing = ctx.db.workspace_setting().key().find(&key);
    let old = existing
        .as_ref()
        .and_then(|r| serde_json::from_str::<SourceConfig>(&r.value_json).ok());
    let mut source: SourceConfig =
        serde_json::from_str(&config_json).map_err(|_| "Invalid source configuration")?;
    source.mappings.clear();
    source.link_property_id.clear();
    source.source_id = Some(source_id.clone());
    validate_source(&source)?;
    let mut imported = None;
    let mut credential = secret;
    if let Some(database_id) = import_database_id {
        if existing.is_some() {
            return Err("Choose a new source id when importing".into());
        }
        require_page_write(ctx, database_id)?;
        let schema = schema_for(ctx, database_id)?;
        let binding = config_for(&schema, true)?;
        if binding.source_id.is_some() {
            return Err("This database already uses a workspace source".into());
        }
        // Promotion only copies the saved endpoint; never forward an existing
        // credential to an address supplied by the caller.
        let mut expected = bind_shared(source.clone(), &binding);
        expected.revision = binding.revision.clone();
        expected.source_id = None;
        if serde_json::to_string(&expected).unwrap() != serde_json::to_string(&binding).unwrap() {
            return Err("Save the existing connection before making it reusable".into());
        }
        if credential.is_none() {
            credential = ctx
                .db
                .external_source_secret()
                .database_id()
                .find(database_id)
                .map(|s| s.secret);
        }
        imported = Some((schema, binding));
    }
    if !source.auth_header.is_empty()
        && credential.is_none()
        && old.as_ref().is_some_and(|o| {
            o.base_url != source.base_url
                || o.auth_header != source.auth_header
                || o.auth_prefix != source.auth_prefix
        })
    {
        return Err(
            "Re-enter the credential when changing the source URL or authentication".into(),
        );
    }
    if source.auth_header.is_empty() {
        ctx.db
            .shared_external_source_secret()
            .source_id()
            .delete(&source_id);
    } else if let Some(secret) = credential {
        let row = SharedExternalSourceSecret {
            source_id: source_id.clone(),
            secret,
            scope: credential_scope(&source),
        };
        if ctx
            .db
            .shared_external_source_secret()
            .source_id()
            .find(&source_id)
            .is_some()
        {
            ctx.db
                .shared_external_source_secret()
                .source_id()
                .update(row);
        } else {
            ctx.db.shared_external_source_secret().insert(row);
        }
    }
    if !source.auth_header.is_empty()
        && ctx
            .db
            .shared_external_source_secret()
            .source_id()
            .find(&source_id)
            .is_none_or(|s| s.secret.is_empty() || s.scope != credential_scope(&source))
    {
        return Err("Enter a credential for this workspace source".into());
    }
    source.revision = ctx
        .timestamp
        .to_duration_since_unix_epoch()
        .unwrap_or_default()
        .as_micros()
        .to_string();
    let value_json = serde_json::to_string(&source).map_err(|_| "Invalid source")?;
    if let Some(row) = existing {
        ctx.db.workspace_setting().id().update(WorkspaceSetting {
            value_json,
            updated_by: ctx.sender(),
            updated_at: ctx.timestamp,
            ..row
        });
    } else {
        ctx.db.workspace_setting().insert(WorkspaceSetting {
            id: next_workspace_setting_id(ctx),
            key,
            value_json,
            updated_by: ctx.sender(),
            updated_at: ctx.timestamp,
        });
    }
    // Refresh cached transport definitions transactionally. Bindings and data
    // remain per database; in-flight snapshots fail the existing revision guard.
    let schemas: Vec<_> = ctx.db.database_schema().iter().collect();
    for mut schema in schemas {
        if let Ok(binding) = config_for(&schema, true) {
            if binding.source_id.as_deref() == Some(source_id.as_str()) {
                let mut config: Value =
                    serde_json::from_str(schema.config.as_deref().unwrap_or("{}"))
                        .map_err(|_| "Invalid database configuration")?;
                config["externalSource"] =
                    serde_json::to_value(bind_shared(source.clone(), &binding)).unwrap();
                schema.config = Some(config.to_string());
                ctx.db.database_schema().id().update(schema);
            }
        }
    }
    if let Some((mut schema, binding)) = imported {
        let mut config: Value = serde_json::from_str(schema.config.as_deref().unwrap_or("{}"))
            .map_err(|_| "Invalid database configuration")?;
        config["externalSource"] = serde_json::to_value(bind_shared(source, &binding)).unwrap();
        schema.config = Some(config.to_string());
        ctx.db
            .external_source_secret()
            .database_id()
            .delete(schema.page_id);
        ctx.db.database_schema().id().update(schema);
    }
    Ok(())
}

#[reducer]
pub fn delete_shared_external_source(
    ctx: &ReducerContext,
    source_id: String,
) -> Result<(), String> {
    require_source_admin(ctx)?;
    if ctx.db.database_schema().iter().any(|s| {
        config_for(&s, true).is_ok_and(|c| c.source_id.as_deref() == Some(source_id.as_str()))
    }) {
        return Err("This source is still connected to a database".into());
    }
    ctx.db
        .workspace_setting()
        .key()
        .delete(format!("{SOURCE_PREFIX}{source_id}"));
    ctx.db
        .shared_external_source_secret()
        .source_id()
        .delete(source_id);
    Ok(())
}

fn row_config(
    ctx: &ReducerContext,
    row_id: u64,
    allow_disabled: bool,
) -> Result<(u64, SourceConfig), String> {
    let row = ctx.db.page().id().find(row_id).ok_or("Row not found")?;
    if row.deleted_at.is_some() {
        return Err("Row is deleted".into());
    }
    let parent = row.parent_id.ok_or("Row is not in a database")?;
    Ok((
        parent,
        config_for(&schema_for(ctx, parent)?, allow_disabled)?,
    ))
}

#[derive(Deserialize, Serialize)]
struct RecordLink {
    id: String,
    label: String,
}

fn set_if_changed(
    ctx: &ReducerContext,
    row_id: u64,
    id: u64,
    value: PropertyValue,
) -> Result<(), String> {
    if !ctx
        .db
        .page_property_value()
        .page_id()
        .filter(row_id)
        .any(|v| v.property_definition_id == id && v.value == value)
    {
        set_property_value_inner(
            ctx,
            row_id,
            id,
            value,
            ActorType::Agent("external-source".into()),
        )?;
    }
    Ok(())
}

#[reducer]
pub fn link_external_record(
    ctx: &ReducerContext,
    row_id: u64,
    record_id: String,
    label: String,
) -> Result<(), String> {
    require_page_write(ctx, row_id)?;
    let (database_id, config) = row_config(ctx, row_id, record_id.is_empty())?;
    if record_id.len() > 512 || label.len() > 1000 || record_id.chars().any(char::is_control) {
        return Err("Invalid external record".into());
    }
    let id: u64 = config
        .link_property_id
        .parse()
        .map_err(|_| "Invalid link column")?;
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(id)
        .ok_or("Link column was deleted")?;
    if prop.schema_id != schema_for(ctx, database_id)?.id
        || prop.property_type != PropertyType::Text
    {
        return Err("Link column changed type or database".into());
    }
    let previous = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(row_id)
        .find(|v| v.property_definition_id == id)
        .and_then(|v| match v.value {
            PropertyValue::Text(raw) => serde_json::from_str::<RecordLink>(&raw).ok(),
            _ => None,
        });
    // Rebinding must not show another record's statistics when the new source
    // has missing data. Unlinking deliberately retains the last known snapshot.
    if !record_id.is_empty() && previous.is_some_and(|old| old.id != record_id) {
        for mapping in &config.mappings {
            let target = mapping
                .target_property_id
                .parse()
                .map_err(|_| "Invalid target column")?;
            clear_property_value(ctx, row_id, target)?;
        }
    }
    let value = if record_id.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&RecordLink {
            id: record_id,
            label,
        })
        .map_err(|_| "Invalid link")?
    };
    set_if_changed(ctx, row_id, id, PropertyValue::Text(value))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldValue {
    property_id: String,
    kind: String,
    value: Value,
}

fn property_value(field: &FieldValue) -> Result<PropertyValue, String> {
    let invalid = || {
        format!(
            "Invalid {} value for column {}",
            field.kind, field.property_id
        )
    };
    Ok(match field.kind.as_str() {
        "Text" => PropertyValue::Text(field.value.as_str().ok_or_else(invalid)?.to_string()),
        "Url" => PropertyValue::Url(field.value.as_str().ok_or_else(invalid)?.to_string()),
        "Select" => PropertyValue::Select(field.value.as_str().ok_or_else(invalid)?.to_string()),
        "Number" => PropertyValue::Number(
            field
                .value
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(invalid)?,
        ),
        "Checkbox" => PropertyValue::Checkbox(field.value.as_bool().ok_or_else(invalid)?),
        "Date" | "Duration" => {
            let n = field
                .value
                .as_u64()
                .or_else(|| field.value.as_str().and_then(|s| s.parse::<u64>().ok()))
                .ok_or_else(invalid)?;
            if field.kind == "Date" {
                PropertyValue::Date(n)
            } else {
                PropertyValue::Duration(n)
            }
        }
        "MultiSelect" => PropertyValue::MultiSelect(
            field
                .value
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|v| v.as_str().map(str::to_string).ok_or_else(invalid))
                .collect::<Result<_, _>>()?,
        ),
        _ => return Err("Unsupported mapped column type".into()),
    })
}

#[reducer]
pub fn apply_external_record(
    ctx: &ReducerContext,
    row_id: u64,
    expected_config: String,
    record_id: String,
    label: String,
    values_json: String,
) -> Result<(), String> {
    require_page_write(ctx, row_id)?;
    let (database_id, config) = row_config(ctx, row_id, false)?;
    let expected: SourceConfig =
        serde_json::from_str(&expected_config).map_err(|_| "Invalid expected source")?;
    if serde_json::to_string(&config).unwrap() != serde_json::to_string(&expected).unwrap() {
        return Err("Source configuration changed; retry sync".into());
    }
    if values_json.len() > 131072
        || record_id.is_empty()
        || record_id.len() > 512
        || label.len() > 1000
    {
        return Err("Invalid external snapshot".into());
    }
    let link_id: u64 = config
        .link_property_id
        .parse()
        .map_err(|_| "Invalid link column")?;
    let link_prop = ctx
        .db
        .property_definition()
        .id()
        .find(link_id)
        .ok_or("Link column was deleted")?;
    if link_prop.property_type != PropertyType::Text {
        return Err("Link column changed type".into());
    }
    let linked =
        ctx.db
            .page_property_value()
            .page_id()
            .filter(row_id)
            .any(|v| {
                v.property_definition_id == link_id
                    && match v.value {
                        PropertyValue::Text(raw) => serde_json::from_str::<RecordLink>(&raw)
                            .is_ok_and(|l| l.id == record_id),
                        _ => false,
                    }
            });
    if !linked {
        return Err("External record link changed; retry sync".into());
    }
    let schema = schema_for(ctx, database_id)?;
    let values: Vec<FieldValue> =
        serde_json::from_str(&values_json).map_err(|_| "Invalid field values")?;
    if values.len() > config.mappings.len() {
        return Err("Unexpected mapped values".into());
    }
    let mut seen = std::collections::HashSet::new();
    for field in values {
        let id: u64 = field.property_id.parse().map_err(|_| "Invalid mapping")?;
        let mapping = config
            .mappings
            .iter()
            .find(|m| m.target_property_id == field.property_id)
            .ok_or("Unmapped column")?;
        let prop = ctx
            .db
            .property_definition()
            .id()
            .find(id)
            .ok_or("Mapped column was deleted")?;
        if prop.schema_id != schema.id
            || supported_type(&prop.property_type) != Some(field.kind.as_str())
            || field.kind != mapping.target_type
            || !seen.insert(id)
        {
            return Err("Mapped column changed type or duplicate value".into());
        }
        set_if_changed(ctx, row_id, id, property_value(&field)?)?;
    }
    set_if_changed(
        ctx,
        row_id,
        link_id,
        PropertyValue::Text(
            serde_json::to_string(&RecordLink {
                id: record_id,
                label: label.clone(),
            })
            .map_err(|_| "Invalid label")?,
        ),
    )?;
    let mut row = ctx.db.page().id().find(row_id).ok_or("Row not found")?;
    if config.fill_empty_title
        && (row.title.trim().is_empty() || row.title == "Untitled")
        && !label.trim().is_empty()
    {
        row.title = label;
        row.updated_at = ctx.timestamp;
        ctx.db.page().id().update(row);
    }
    Ok(())
}
