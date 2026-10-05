// ============================================================
// Access Control Reducers
// ============================================================
//
// "Mutating the rules of the page" is itself a write on the page. Once a
// page has any rule, only existing writers (or admins) can change the rule
// set — otherwise a single mistake could lock the workspace out. A page
// with zero rules is open, so anyone can install the *first* rule.

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::access_control::helpers::{
    explicit_page_access_rule_allows, principal_matches_identity, require_rule_authority,
    workspace_member,
};
use crate::access_control::{
    block_access_rule, next_block_access_rule_id, next_page_access_request_id,
    next_page_access_rule_id, page_access_request, page_access_rule, AccessRequestStatus,
    BlockAccessRule, PageAccessRequest, PageAccessRule,
};
use crate::pages::page;
use crate::types::Permission;

fn upsert_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    permission: Permission,
) {
    let existing: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in existing {
        ctx.db.page_access_rule().id().delete(rule.id);
    }

    ctx.db.page_access_rule().insert(PageAccessRule {
        id: next_page_access_rule_id(ctx),
        page_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
}

/// Request page access. The request is created by the caller for itself;
/// a principal with rule authority on the page (or an admin) approves it
/// into a real `PageAccessRule`.
#[reducer]
pub fn request_page_access(
    ctx: &ReducerContext,
    page_id: u64,
    permission: Permission,
    reason: String,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;

    if explicit_page_access_rule_allows(ctx, page_id, ctx.sender(), &permission) {
        return Ok(());
    }

    let has_pending = ctx
        .db
        .page_access_request()
        .page_id()
        .filter(&page_id)
        .any(|r| {
            principal_matches_identity(&r.principal, ctx.sender())
                && r.permission == permission
                && r.status == AccessRequestStatus::Pending
        });
    if has_pending {
        return Ok(());
    }

    let trimmed = reason.trim();
    ctx.db.page_access_request().insert(PageAccessRequest {
        id: next_page_access_request_id(ctx),
        page_id,
        principal: workspace_member(ctx.sender()),
        permission,
        requested_by: ctx.sender(),
        reason: if trimmed.is_empty() {
            "Access requested".to_string()
        } else {
            trimmed.chars().take(500).collect()
        },
        status: AccessRequestStatus::Pending,
        requested_at: ctx.timestamp,
        resolved_by: None,
        resolved_at: None,
    });
    Ok(())
}

/// Resolve a pending access request. Approving installs a normal
/// page-access rule; denying only closes the request. Both require rule
/// authority on the page (writers and admins).
#[reducer]
pub fn resolve_page_access_request(
    ctx: &ReducerContext,
    request_id: u64,
    approve: bool,
) -> Result<(), String> {
    let request = ctx
        .db
        .page_access_request()
        .id()
        .find(request_id)
        .ok_or("Access request not found")?;
    if request.status != AccessRequestStatus::Pending {
        return Ok(());
    }
    require_rule_authority(ctx, request.page_id)?;

    if approve {
        let principal = match &request.principal {
            crate::types::Principal::WorkspaceMember(id) => *id,
        };
        upsert_page_access_rule(ctx, request.page_id, principal, request.permission.clone());
    }

    ctx.db.page_access_request().id().update(PageAccessRequest {
        status: if approve {
            AccessRequestStatus::Approved
        } else {
            AccessRequestStatus::Denied
        },
        resolved_by: Some(ctx.sender()),
        resolved_at: Some(ctx.timestamp),
        ..request
    });
    Ok(())
}

/// Grants `principal` `permission` on `page_id`. Upserts: if a rule already
/// exists for the principal it is replaced (so promoting Read → Write is
/// idempotent and Write → Read is a true demotion).
#[reducer]
pub fn set_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;
    upsert_page_access_rule(ctx, page_id, principal, permission);
    Ok(())
}

/// Removes any rule for `principal` on `page_id`. If this drops the rule
/// count to zero the page returns to the open model.
#[reducer]
pub fn clear_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let to_delete: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in to_delete {
        ctx.db.page_access_rule().id().delete(rule.id);
    }
    Ok(())
}

#[reducer]
pub fn set_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    if block_id.trim().is_empty() {
        return Err("block_id cannot be empty".to_string());
    }
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let existing: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| r.block_id == block_id && principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in existing {
        ctx.db.block_access_rule().id().delete(rule.id);
    }

    ctx.db.block_access_rule().insert(BlockAccessRule {
        id: next_block_access_rule_id(ctx),
        page_id,
        block_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn clear_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;
    let to_delete: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| r.block_id == block_id && principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in to_delete {
        ctx.db.block_access_rule().id().delete(rule.id);
    }
    Ok(())
}
