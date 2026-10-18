// ============================================================
// Block comments (human collaboration)
// ============================================================
//
// Page-level and block-anchored comment threads. Plain human discussion:
// no agents, no triggers, no notifications — the panel reads this table
// live. A comment is visible iff its page is readable (see
// `BLOCK_COMMENT_READ` in `access_control/read_visibility.rs`).

use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use crate::access_control::helpers::require_page_read;
use crate::auth::{sender_account_email, sender_is_admin, user};
use crate::id_counters::alloc_id;
use crate::module_install::sender_is_module_publisher;
use crate::pages::page;

pub(crate) fn next_block_comment_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "block_comment", || {
        ctx.db
            .block_comment()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// A single comment. `block_id == None` means a page-level comment;
/// otherwise it anchors to a component-node id (opaque string — the node
/// may be deleted later, the comment survives with a stale anchor).
/// `parent_id == None` means a thread root, otherwise a reply.
///
/// Authorship belongs to the **account**, not the identity — the same trust
/// model as admin authority (`UserCredential.is_admin`). `author` keeps the
/// writing identity for the fast equality path and legacy rows;
/// `author_email` is the normalized email snapshot taken at write time, so a
/// comment survives its author losing that browser identity (cleared
/// storage, new device). `None` only on rows written before the column
/// existed, on rows restored from old snapshots, or by a caller with no
/// authenticated account — `backfill_comment_authors` repairs the legacy
/// rows from the old identity's `User` row.
#[table(accessor = block_comment, public)]
pub struct BlockComment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub block_id: Option<String>,
    pub parent_id: Option<u64>,
    pub author: Identity,
    pub content: String,
    pub resolved: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    // Schema order is persistent: 2.0.3 can only append columns with defaults.
    // Keep all legacy columns above in their original order.
    #[default(Option::<String>::None)]
    pub author_email: Option<String>,
}

pub(crate) fn validate_comment_content(content: &str) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Comment cannot be empty".to_string());
    }
    if trimmed.chars().count() > 4000 {
        return Err("Comment is too long (max 4000 characters)".to_string());
    }
    Ok(trimmed.to_string())
}

fn author_or_admin(ctx: &ReducerContext, comment: &BlockComment) -> Result<(), String> {
    let same_account = comment
        .author_email
        .as_deref()
        .is_some_and(|email| !email.is_empty() && sender_account_email(ctx) == email);
    if comment.author == ctx.sender() || same_account || sender_is_admin(ctx) {
        Ok(())
    } else {
        Err("Only the author or a workspace admin can do this".to_string())
    }
}

/// Post a comment (or a reply when `parent_id` is set) on a page the
/// caller can read. Replies must target a comment on the same page.
#[reducer]
pub fn create_block_comment(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: Option<String>,
    parent_id: Option<u64>,
    content: String,
) -> Result<(), String> {
    ctx.db.page().id().find(page_id).ok_or("Page not found")?;
    require_page_read(ctx, page_id)?;
    let content = validate_comment_content(&content)?;
    let block_id = match block_id {
        Some(b) if b.trim().is_empty() => None,
        other => other,
    };
    if let Some(pid) = parent_id {
        let parent = ctx
            .db
            .block_comment()
            .id()
            .find(pid)
            .ok_or("Parent comment not found")?;
        if parent.page_id != page_id {
            return Err("Parent comment is on a different page".to_string());
        }
    }
    ctx.db.block_comment().insert(BlockComment {
        id: next_block_comment_id(ctx),
        page_id,
        block_id,
        parent_id,
        author: ctx.sender(),
        author_email: Some(sender_account_email(ctx)),
        content,
        resolved: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

/// Edit own comment (or any, as admin). Editing bumps `updated_at`.
#[reducer]
pub fn update_block_comment(
    ctx: &ReducerContext,
    comment_id: u64,
    content: String,
) -> Result<(), String> {
    let comment = ctx
        .db
        .block_comment()
        .id()
        .find(comment_id)
        .ok_or("Comment not found")?;
    author_or_admin(ctx, &comment)?;
    let content = validate_comment_content(&content)?;
    ctx.db.block_comment().id().update(BlockComment {
        content,
        updated_at: ctx.timestamp,
        ..comment
    });
    Ok(())
}

/// Resolve / reopen a thread. Only the root carries `resolved`; resolving
/// any reply resolves its root.
#[reducer]
pub fn resolve_block_comment(
    ctx: &ReducerContext,
    comment_id: u64,
    resolved: bool,
) -> Result<(), String> {
    let comment = ctx
        .db
        .block_comment()
        .id()
        .find(comment_id)
        .ok_or("Comment not found")?;
    let root_id = comment.parent_id.unwrap_or(comment.id);
    let root = ctx
        .db
        .block_comment()
        .id()
        .find(root_id)
        .ok_or("Thread root not found")?;
    author_or_admin(ctx, &root)?;
    ctx.db.block_comment().id().update(BlockComment {
        resolved,
        updated_at: ctx.timestamp,
        ..root
    });
    Ok(())
}

/// Delete a comment and all its replies. Author or admin only.
#[reducer]
pub fn delete_block_comment(ctx: &ReducerContext, comment_id: u64) -> Result<(), String> {
    let comment = ctx
        .db
        .block_comment()
        .id()
        .find(comment_id)
        .ok_or("Comment not found")?;
    author_or_admin(ctx, &comment)?;
    // Collect the whole subtree (root + descendants at any depth).
    let mut stack = vec![comment_id];
    let mut to_delete = Vec::new();
    while let Some(id) = stack.pop() {
        to_delete.push(id);
        for child in ctx
            .db
            .block_comment()
            .iter()
            .filter(|c| c.parent_id == Some(id))
        {
            stack.push(child.id);
        }
    }
    for id in to_delete {
        ctx.db.block_comment().id().delete(id);
    }
    Ok(())
}

/// Link legacy comments to their author's account.
///
/// Comments written before `author_email` existed carry only the ephemeral
/// identity; when that identity is lost the UI can no longer tell whose
/// comment it was. This copies the normalized email from the `User` row of
/// each comment's author identity — the same migration pattern as
/// `backfill_credential_admin`: safe to re-run, no batching (one bounded
/// index lookup per comment, unlike the PBKDF2 rounds the password backfill
/// has to budget for). Comments whose author identity has no authenticated
/// `User` row yet are left unlinked; a later run links them once the row is
/// authenticated.
///
/// Run automatically via `run_pending_migrations`
/// (`"block_comment_author_email_backfill_v1"`, invoked by the docker
/// entrypoint after every publish); the publisher-gated reducer stays as the
/// re-runnable escape hatch for rows linked late.
#[reducer]
pub fn backfill_comment_authors(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("Only the publisher may migrate comment authors".into());
    }
    let linked = backfill_comment_authors_inner(ctx);
    log::info!("backfill_comment_authors: linked {linked} comments to accounts");
    Ok(())
}

pub(crate) fn backfill_comment_authors_inner(ctx: &ReducerContext) -> u32 {
    let mut linked = 0u32;
    for comment in ctx
        .db
        .block_comment()
        .iter()
        .filter(|c| c.author_email.is_none())
    {
        let email = ctx
            .db
            .user()
            .identity()
            .find(comment.author)
            .filter(|u| u.is_authenticated)
            .map(|u| u.email.trim().to_lowercase())
            .unwrap_or_default();
        if email.is_empty() {
            continue;
        }
        ctx.db.block_comment().id().update(BlockComment {
            author_email: Some(email),
            ..comment
        });
        linked += 1;
    }
    linked
}
