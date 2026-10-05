//! Authentication: User, UserCredential, UserPreference tables and the
//! native register/login/admin reducers. Session hooks
//! (`client_connected`, `client_disconnected`) live in `lib.rs` but call
//! into `extract_oidc_profile` here.

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use crate::id_counters::alloc_id;

pub(crate) fn next_user_preference_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "user_preference", || {
        ctx.db
            .user_preference()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// Connected user — upserted on every client_connected event.
/// is_authenticated is set to true only after a successful login/register call.
#[table(accessor = user, public)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub email: String,
    pub is_authenticated: bool,
    pub created_at: Timestamp,
    pub last_seen_at: Timestamp,
    /// Workspace admin flag.
    ///
    /// In SELFbase's trust model an authenticated user can read and edit any
    /// workspace content (Pages have no per-row ownership check). Admins
    /// additionally inherit management rights over shared *infrastructure*
    /// rows that DO have a `created_by` field — `api_endpoint`,
    /// `api_field_mapping`, `api_endpoint_key` — so a co-worker can clean
    /// up an orphaned endpoint after a teammate leaves the workspace, a
    /// stale-tab/wipe accident leaves a row owned by an unreachable
    /// identity, or an OIDC `sub` rotation strands the original creator.
    ///
    /// Bootstrap: the first user to authenticate (native register/login
    /// or OIDC connect) on a fresh database is auto-promoted to admin.
    /// After that, only existing admins can promote or demote others via
    /// `set_user_admin`. The reducer also forbids removing the last admin
    /// so a workspace can never end up with zero admins.
    ///
    /// Extension and AI-user rows deliberately do NOT honor this flag —
    /// they're per-installer / per-creator by design (see
    /// `docs/SELFBASE_EXTENSIONS_SECURITY.MD`).
    #[default(false)]
    pub is_admin: bool,
}

/// Stores hashed credentials — never synced to clients (private).
#[derive(Clone)]
#[table(accessor = user_credential, private)]
pub struct UserCredential {
    #[primary_key]
    pub email: String,
    pub name: String,
    /// Versioned PBKDF2-HMAC-SHA256 envelope; legacy digests require migration.
    pub password_hash: String,
    pub created_at: Timestamp,
    /// Account-level admin flag — the authority belongs to the *account*, not
    /// to one browser.
    ///
    /// `User.is_admin` is per-identity, and a SpacetimeDB identity lives in the
    /// browser's localStorage: clearing storage, a new device or a reinstall
    /// mints a brand-new identity that starts as a plain user. Authority
    /// therefore travels with the credential and `login` copies it onto
    /// whichever identity authenticates (see `login`). Only a successful
    /// password login confers it — a bare identity token never does.
    ///
    /// One email may back several identities (every device the account logged
    /// in from), so `set_user_admin` treats the email as the unit of
    /// administration and cascades a demotion to all of that account's rows.
    #[default(false)]
    pub is_admin: bool,
}

/// Publisher-configured trust anchor. Empty/missing means native login only.
#[table(accessor = oidc_trust_policy, private)]
pub struct OidcTrustPolicy {
    #[primary_key]
    pub id: u8,
    pub issuer: String,
    pub audience: String,
}

#[reducer]
pub fn set_oidc_trust_policy(ctx: &ReducerContext, issuer: String, audience: String) -> Result<(), String> {
    if !crate::module_install::sender_is_module_publisher(ctx) {
        return Err("Only the publisher may configure OIDC trust".into());
    }
    if !issuer.starts_with("https://") || !audience.split(',').any(|s| !s.trim().is_empty()) {
        return Err("OIDC requires an HTTPS issuer and a non-empty audience".into());
    }
    let row = OidcTrustPolicy { id: 0, issuer, audience };
    if ctx.db.oidc_trust_policy().id().find(0).is_some() {
        ctx.db.oidc_trust_policy().id().update(row);
    } else { ctx.db.oidc_trust_policy().insert(row); }
    Ok(())
}

/// Per-human user preferences. Sparse — only stores the keys the user has
/// explicitly set; defaults live in code. The `key` namespace is dotted
/// (e.g. `mention.thread_behavior`).
#[table(accessor = user_preference, public,
        index(accessor = user_preference_identity_key,
              btree(columns = [identity, key])))]
pub struct UserPreference {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub key: String,
    pub value_json: String,
    pub updated_at: Timestamp,
}
// ============================================================
// Auth Reducers
// ============================================================

/// Bootstraps the first native account and authenticates the current identity.
/// Once initialized, administrators must provision additional native accounts.
#[reducer]
pub fn register(
    ctx: &ReducerContext,
    email: String,
    name: String,
    password: String,
) -> Result<(), String> {
    if ctx.db.user_credential().iter().next().is_some() || ctx.db.user().iter().any(|u| u.is_admin) {
        return Err("This workspace is already initialized; ask an admin to create your account".to_string());
    }

    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Err("Email is required".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if password.len() < 12 || password.len() > 1024 {
        return Err("Password must be between 12 and 1024 bytes".to_string());
    }
    if ctx.db.user_credential().email().find(&email).is_some() {
        return Err("Email already registered".to_string());
    }

    // Bootstrap authority is recorded on the credential so it survives this
    // identity being lost; `login` re-applies it on every device.
    let is_admin = workspace_has_no_admin(ctx);

    ctx.db.user_credential().insert(UserCredential {
        email: email.clone(),
        name: name.clone(),
        password_hash: harden_digest(&current_password_digest(&email, &password), &crate::stable_ids::generate_external_id(ctx, "password-salt", &email)),
        created_at: ctx.timestamp,
        is_admin,
    });

    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            email,
            name,
            is_authenticated: true,
            is_admin: existing.is_admin || is_admin,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
    Ok(())
}

/// Admin-created native-login account for self-hosted/dev workspaces.
///
/// This intentionally creates only a `UserCredential` row. The human's actual
/// `User` row is tied to the SpacetimeDB identity they connect with, so it is
/// created/authenticated when they first log in with this credential.
#[reducer]
pub fn create_local_user(
    ctx: &ReducerContext,
    email: String,
    name: String,
    password: String,
) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can add local users".to_string());
    }

    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Err("Email is required".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if password.len() < 12 || password.len() > 1024 {
        return Err("Password must be between 12 and 1024 bytes".to_string());
    }
    if ctx.db.user_credential().email().find(&email).is_some() {
        return Err("Email already registered".to_string());
    }

    ctx.db.user_credential().insert(UserCredential {
        email: email.clone(),
        name,
        password_hash: harden_digest(&current_password_digest(&email, &password), &crate::stable_ids::generate_external_id(ctx, "password-salt", &email)),
        created_at: ctx.timestamp,
        // Admin-created accounts are never admin themselves — `set_user_admin`
        // is the only path to that, so the privilege is explicit.
        is_admin: false,
    });
    Ok(())
}

/// Verifies credentials and marks the current identity as authenticated.
#[reducer]
pub fn login(ctx: &ReducerContext, email: String, password: String) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if email.len() > 320 || password.len() > 1024 { return Err("Invalid credentials".into()); }
    let Some(mut cred) = ctx.db.user_credential().email().find(&email) else {
        record_login_result(ctx, false, "Invalid email or password");
        return Ok(());
    };
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let mut attempts = ctx.db.local_login_attempt().email().find(&email)
        .unwrap_or(LocalLoginAttempt { email: email.clone(), window_start: now, attempts: 0 });
    if now.saturating_sub(attempts.window_start) >= 900_000_000 {
        attempts.window_start = now;
        attempts.attempts = 0;
    }
    if attempts.attempts >= 10 {
        record_login_result(ctx, false, "Too many attempts; try again in 15 minutes");
        return Ok(());
    }
    attempts.attempts += 1;
    let digest = current_password_digest(&email, &password);
    let valid = verify_password_digest(&cred.password_hash, &digest);
    if valid { attempts.attempts = 0; }
    if ctx.db.local_login_attempt().email().find(&email).is_some() {
        ctx.db.local_login_attempt().email().update(attempts);
    } else { ctx.db.local_login_attempt().insert(attempts); }
    // Returning Err would roll back the failed-attempt counter. The caller
    // observes its private login_result row; authentication remains false.
    if !valid {
        record_login_result(ctx, false, "Invalid email or password");
        return Ok(());
    }
    if !cred.password_hash.starts_with("pbkdf2-sha256-v1$") {
        cred.password_hash = harden_digest(&digest, &crate::stable_ids::generate_external_id(ctx, "password-salt", &email));
        ctx.db.user_credential().email().update(cred.clone());
    }
    record_login_result(ctx, true, "");

    let identity = ctx.sender();
    let needs_bootstrap_admin = workspace_has_no_admin(ctx);
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        // Authority follows the account: a fresh identity that authenticates with
        // an admin credential becomes admin, so clearing browser storage or
        // signing in on another device no longer costs the admin role.
        let is_admin =
            resolve_admin_on_login(cred.is_admin, existing.is_admin, needs_bootstrap_admin);
        ctx.db.user().identity().update(User {
            email,
            name: cred.name,
            is_authenticated: true,
            is_admin,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
    Ok(())
}

/// Promote or demote a workspace user. Only existing admins can call this.
///
/// Administration belongs to the **account**, so the change is recorded on the
/// `UserCredential` for the target's email and cascaded to every `User` row
/// carrying that email — one account may own several identities (every device
/// it signed in from), and demoting only the row that happened to be clicked
/// would leave the other devices privileged.
///
/// Refuses to demote the last remaining admin account so the workspace can
/// never end up admin-less (which would lock everyone out of orphan-cleanup
/// operations on shared infrastructure rows). Identities that authenticate
/// through OIDC have no credential and are therefore tracked by their `User`
/// row alone.
#[reducer]
pub fn set_user_admin(
    ctx: &ReducerContext,
    target_identity: Identity,
    is_admin: bool,
) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can change admin status".to_string());
    }

    let target = ctx
        .db
        .user()
        .identity()
        .find(target_identity)
        .ok_or("Target user not found")?;

    let target_email = target.email.trim().to_lowercase();
    let credential = ctx.db.user_credential().email().find(&target_email);

    if target.is_admin == is_admin && credential.as_ref().map(|c| c.is_admin) != Some(is_admin) {
        return Ok(());
    }

    if !is_admin && (target.is_admin || credential.as_ref().map(|c| c.is_admin).unwrap_or(false)) {
        // Count admins outside this account: another identity of the same
        // account does not make demotion safe.
        let other_admins = count_admins_outside_account(
            ctx.db
                .user()
                .iter()
                .map(|u| (u.email.trim().to_lowercase(), u.is_admin)),
            &target_email,
        );
        if other_admins == 0 {
            return Err("Cannot demote the last admin — promote another user first".to_string());
        }
    }

    if !target_email.is_empty() {
        if let Some(cred) = credential {
            ctx.db
                .user_credential()
                .email()
                .update(UserCredential { is_admin, ..cred });
        }
        // Every identity of this account follows the credential, so a demotion
        // cannot be dodged by switching devices.
        let same_account: Vec<User> = ctx
            .db
            .user()
            .iter()
            .filter(|u| u.email.trim().to_lowercase() == target_email && u.is_admin != is_admin)
            .collect();
        for row in same_account {
            ctx.db.user().identity().update(User { is_admin, ..row });
        }
    }

    if target.is_admin != is_admin {
        ctx.db.user().identity().update(User { is_admin, ..target });
    }
    Ok(())
}

/// Marks the current identity as logged out.
#[reducer]
pub fn logout(ctx: &ReducerContext) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            is_authenticated: false,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
}

/// Allows the client to push updated OIDC profile claims after reconnect.
/// No-op when called by an unauthenticated identity.
#[reducer]
pub fn set_user_profile(ctx: &ReducerContext, name: String, email: String) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        if !existing.is_authenticated {
            return;
        }
        ctx.db.user().identity().update(User {
            name,
            email,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
}

/// True iff the calling identity is an authenticated workspace admin.
///
/// Used by ownership-gated reducers that want to grant admins a management
/// override on shared infrastructure rows (currently the `api_endpoint`,
/// `api_field_mapping`, and `api_endpoint_key` family). Anyone querying
/// this MUST also separately enforce that the row is the right *kind* of
/// resource for an admin override — extension and AI-user rows are
/// per-installer / per-creator by design and don't honor this flag.
pub(crate) fn sender_is_admin(ctx: &ReducerContext) -> bool {
    ctx.db
        .user()
        .identity()
        .find(ctx.sender())
        .map(|u| u.is_admin && u.is_authenticated)
        .unwrap_or(false)
}

/// True iff the workspace has no administrator, including logged-out admins.
/// The first authenticated user on a fresh database is auto-promoted; logging
/// out must not reopen this bootstrap path.
pub(crate) fn workspace_has_no_admin(ctx: &ReducerContext) -> bool {
    !ctx.db
        .user()
        .iter()
        .any(|u| u.is_admin)
}

/// Parses OIDC `email` and `name`/`preferred_username` claims from the sender's JWT.
/// Returns empty strings when no OIDC token is present (anonymous connection).
pub(crate) fn extract_oidc_profile(ctx: &ReducerContext) -> (String, String) {
    let Some(jwt) = ctx.sender_auth().jwt() else {
        return (String::new(), String::new());
    };
    let Ok(claims) = serde_json::from_str::<serde_json::Value>(jwt.raw_payload()) else {
        return (String::new(), String::new());
    };
    let Some(policy) = ctx.db.oidc_trust_policy().id().find(0) else {
        return (String::new(), String::new());
    };
    if !trusted_oidc_claims(&claims, &policy.issuer, &policy.audience) {
        return (String::new(), String::new());
    }
    let email = claims["email"].as_str().unwrap_or("").to_string();
    let name = claims["name"]
        .as_str()
        .or_else(|| claims["preferred_username"].as_str())
        .unwrap_or("")
        .to_string();
    (email, name)
}

fn trusted_oidc_claims(claims: &serde_json::Value, issuer: &str, audience: &str) -> bool {
    claims["iss"].as_str() == Some(issuer)
        && audience.split(',').map(str::trim).filter(|a| !a.is_empty()).any(|audience|
            claims["aud"].as_str() == Some(audience)
            || claims["aud"].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(audience))))
}
/// Admin flag for an identity that just authenticated with a native account.
///
/// Account authority is the point of this function: a credential flagged admin
/// makes *any* identity that logs in with it an admin, so losing the browser's
/// identity token no longer costs the role. The other two inputs keep their
/// meaning — an identity that already holds the flag keeps it, and the first
/// user on a fresh database is still bootstrapped.
fn resolve_admin_on_login(
    cred_is_admin: bool,
    existing_is_admin: bool,
    needs_bootstrap_admin: bool,
) -> bool {
    cred_is_admin || existing_is_admin || needs_bootstrap_admin
}

/// Admins that would survive demoting `target_email`'s account.
///
/// Every identity of the target's account is demoted together, so its other
/// identities must not count as remaining admins — otherwise the last-admin
/// guard could be defeated by logging in on a second device first.
fn count_admins_outside_account<'a>(
    rows: impl Iterator<Item = (String, bool)>,
    target_email: &str,
) -> usize {
    rows.filter(|(email, is_admin)| *is_admin && !email.eq_ignore_ascii_case(target_email))
        .count()
}

/// Domain separator for password hashing. All hashes use the V2 domain.
/// (Pre-rebrand `pear-auth-v1` hashes were transparently upgraded on login
/// while the fallback existed; it has since been removed.)
const AUTH_DOMAIN_V2: &str = "selfbase-auth-v1";

/// SHA-256( email + NUL + password + NUL + domain ) as lowercase hex.
/// The email acts as a per-user salt — simple and deterministic, fine for local use.
fn password_digest(email: &str, password: &str, domain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.as_bytes());
    hasher.update(b"\x00");
    hasher.update(password.as_bytes());
    hasher.update(b"\x00");
    hasher.update(domain.as_bytes());
    hex::encode(hasher.finalize())
}

fn current_password_digest(email: &str, password: &str) -> String {
    password_digest(email, password, AUTH_DOMAIN_V2)
}
/// Set / clear a per-user preference. `value_json` of empty string clears
/// (matches the typical "set to default" UI gesture).
#[reducer]
pub fn set_user_preference(
    ctx: &ReducerContext,
    key: String,
    value_json: String,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("preference key cannot be empty".to_string());
    }
    let identity = ctx.sender();
    let existing: Option<UserPreference> = ctx
        .db
        .user_preference()
        .identity()
        .filter(&identity)
        .find(|p| p.key == key);

    if value_json.is_empty() {
        if let Some(existing) = existing {
            ctx.db.user_preference().id().delete(existing.id);
        }
        return Ok(());
    }

    match existing {
        Some(existing) => {
            ctx.db.user_preference().id().update(UserPreference {
                value_json,
                updated_at: ctx.timestamp,
                ..existing
            });
        }
        None => {
            ctx.db.user_preference().insert(UserPreference {
                id: next_user_preference_id(ctx),
                identity,
                key,
                value_json,
                updated_at: ctx.timestamp,
            });
        }
    }
    Ok(())
}

// ============================================================
// Workspace settings
// ============================================================

pub(crate) fn next_workspace_setting_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "workspace_setting", || {
        ctx.db
            .workspace_setting()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// Workspace-wide policy, as opposed to `UserPreference` which is per-person.
///
/// Some knobs govern how the workspace behaves for everyone — notably how far
/// an AI-to-AI exchange may run before it stops waking anyone. That is not a
/// personal preference: one member raising their own limit would change what
/// agents do in threads other people read, and it needs to be inspectable by
/// whoever is accountable for the token spend.
///
/// Deliberately a generic key/value table rather than a column per knob, so a
/// new policy needs no migration. Values are JSON so a knob can grow structure
/// later without changing the shape here.
#[table(accessor = workspace_setting, public)]
pub struct WorkspaceSetting {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub key: String,
    pub value_json: String,
    pub updated_by: Identity,
    pub updated_at: Timestamp,
}

/// Key for the AI-to-AI hop budget. See `MAX_AI_HOPS` in the worker.
pub const SETTING_AI_MAX_HOPS: &str = "ai.max_hops";

/// Ceiling on the configurable hop budget. The *default* when unset lives with
/// the consumer (the worker's `MAX_AI_HOPS`), so there is one fallback rather
/// than two that can drift.
///
///
/// A setting is not an escape hatch: the point of the budget is that a runaway
/// agent exchange is bounded, and a workspace that sets it to a million has
/// removed the brake while believing it still has one. High enough to be
/// generous, low enough to stay a brake.
pub const AI_MAX_HOPS_CEILING: u32 = 50;

/// Set a workspace-wide setting. Admin-only: this is policy, not preference.
#[reducer]
pub fn set_workspace_setting(
    ctx: &ReducerContext,
    key: String,
    value_json: String,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("setting key cannot be empty".to_string());
    }
    if !sender_is_admin(ctx) {
        return Err("Only a workspace admin can change workspace settings".to_string());
    }

    // Validate the knobs we know about, so a bad value is rejected at the
    // boundary rather than silently falling back to a default at read time —
    // an admin who sets a limit should be told it did not take.
    if key == SETTING_AI_MAX_HOPS {
        let parsed: u32 = value_json
            .trim()
            .parse()
            .map_err(|_| format!("{SETTING_AI_MAX_HOPS} must be a whole number"))?;
        if parsed == 0 {
            return Err(format!(
                "{SETTING_AI_MAX_HOPS} must be at least 1; use 1 to allow a single AI reply"
            ));
        }
        if parsed > AI_MAX_HOPS_CEILING {
            return Err(format!(
                "{SETTING_AI_MAX_HOPS} may not exceed {AI_MAX_HOPS_CEILING} — the budget exists to bound a runaway exchange"
            ));
        }
    }

    if let Some(existing) = ctx.db.workspace_setting().key().find(&key) {
        ctx.db.workspace_setting().id().update(WorkspaceSetting {
            value_json,
            updated_by: ctx.sender(),
            updated_at: ctx.timestamp,
            ..existing
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
    Ok(())
}


#[table(accessor = local_login_attempt, private)]
pub struct LocalLoginAttempt {
    #[primary_key]
    pub email: String,
    pub window_start: i64,
    pub attempts: u32,
}

#[table(accessor = login_result, public)]
pub struct LoginResult {
    #[primary_key]
    pub identity: Identity,
    pub success: bool,
    pub message: String,
    pub at: Timestamp,
}

#[spacetimedb::client_visibility_filter]
const LOGIN_RESULT_READ: spacetimedb::Filter = spacetimedb::Filter::Sql("SELECT * FROM login_result WHERE identity = :sender");

fn record_login_result(ctx: &ReducerContext, success: bool, message: &str) {
    let row = LoginResult { identity: ctx.sender(), success, message: message.into(), at: ctx.timestamp };
    if ctx.db.login_result().identity().find(ctx.sender()).is_some() {
        ctx.db.login_result().identity().update(row);
    } else { ctx.db.login_result().insert(row); }
}

const PASSWORD_ROUNDS: u32 = 600_000;
fn harden_digest(digest: &str, salt: &str) -> String {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(digest.as_bytes(), salt.as_bytes(), PASSWORD_ROUNDS, &mut out);
    format!("pbkdf2-sha256-v1${}${}", salt, hex::encode(out))
}
fn verify_password_digest(stored: &str, digest: &str) -> bool {
    use subtle::ConstantTimeEq;
    if let Some(rest) = stored.strip_prefix("pbkdf2-sha256-v1$") {
        let Some((salt, _)) = rest.split_once('$') else { return false; };
        stored.as_bytes().ct_eq(harden_digest(digest, salt).as_bytes()).into()
    } else {
        stored.as_bytes().ct_eq(digest.as_bytes()).into()
    }
}

/// Harden legacy stored digests without needing users' plaintext passwords.
/// Bounded batches avoid a long-running migration transaction.
#[reducer]
pub fn harden_local_passwords(ctx: &ReducerContext, limit: u32) -> Result<(), String> {
    if !crate::module_install::sender_is_module_publisher(ctx) {
        return Err("Only the publisher may migrate passwords".into());
    }
    let rows: Vec<_> = ctx.db.user_credential().iter()
        .filter(|c| !c.password_hash.starts_with("pbkdf2-sha256-v1$"))
        .take(limit.clamp(1, 10) as usize).collect();
    for mut row in rows {
        row.password_hash = harden_digest(&row.password_hash, &crate::stable_ids::generate_external_id(ctx, "password-salt", &row.email));
        ctx.db.user_credential().email().update(row);
    }
    Ok(())
}

/// Carry admin authority from the per-identity flag onto the account.
///
/// Run once after upgrading a database that predates `UserCredential.is_admin`:
/// every email that currently owns an admin `User` row gets `is_admin = true` on
/// its credential, so signing in from a new device keeps the role. Idempotent —
/// credentials that already carry the flag are left untouched, and credentials
/// with no admin identity are never promoted. Publisher-only, like every other
/// privileged maintenance reducer.
#[reducer]
pub fn backfill_credential_admin(ctx: &ReducerContext) -> Result<(), String> {
    if !crate::module_install::sender_is_module_publisher(ctx) {
        return Err("Only the publisher may migrate admin authority".into());
    }
    let mut admin_emails: Vec<String> = Vec::new();
    for user in ctx.db.user().iter().filter(|u| u.is_admin) {
        let email = user.email.trim().to_lowercase();
        if !email.is_empty() && !admin_emails.contains(&email) {
            admin_emails.push(email);
        }
    }
    for email in admin_emails {
        let Some(cred) = ctx.db.user_credential().email().find(&email) else { continue };
        if !cred.is_admin {
            ctx.db.user_credential().email().update(UserCredential { is_admin: true, ..cred });
        }
    }
    Ok(())
}

/// Re-grant admin access when every admin identity has been lost.
///
/// `User.is_admin` is keyed by SpacetimeDB identity, so clearing browser
/// storage or moving to a new machine can leave an account authenticated but
/// unprivileged — and `set_user_admin` needs an admin to call, so the workspace
/// would be stuck. This is the escape hatch: publisher-only, and it promotes the
/// most recently active authenticated user (falling back to the most recent
/// credential when nobody is signed in). The promoted account's credential is
/// flagged too, so the role survives the next device change.
///
/// Refuses when an authenticated admin already exists — use `set_user_admin` for
/// ordinary changes, this is only for the locked-out case.
#[reducer]
pub fn recover_admin(ctx: &ReducerContext) -> Result<(), String> {
    if !crate::module_install::sender_is_module_publisher(ctx) {
        return Err("Only the publisher may recover admin access".into());
    }
    if ctx.db.user().iter().any(|u| u.is_admin && u.is_authenticated) {
        return Err("An authenticated admin already exists — use set_user_admin".into());
    }

    let mut candidates: Vec<User> = ctx.db.user().iter().filter(|u| u.is_authenticated).collect();
    candidates.sort_by_key(|u| u.last_seen_at);

    if let Some(target) = candidates.pop() {
        let email = target.email.trim().to_lowercase();
        ctx.db.user().identity().update(User { is_admin: true, ..target });
        if let Some(cred) = ctx.db.user_credential().email().find(&email) {
            if !cred.is_admin {
                ctx.db.user_credential().email().update(UserCredential { is_admin: true, ..cred });
            }
        }
        return Ok(());
    }

    // Nobody is signed in: flag the newest credential so the next password
    // login lands as admin (see `login`).
    let Some(cred) = ctx.db.user_credential().iter().max_by_key(|c| c.created_at) else {
        return Err("No user or credential rows to promote".into());
    };
    if !cred.is_admin {
        ctx.db.user_credential().email().update(UserCredential { is_admin: true, ..cred });
    }
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn login_grants_admin_from_the_account_credential() {
        // A brand-new device (no existing row, no bootstrap) still becomes
        // admin because the *account* is an admin — this is the case that used
        // to silently cost the role.
        assert!(resolve_admin_on_login(true, false, false));
        // A plain account never becomes admin, however often it signs in.
        assert!(!resolve_admin_on_login(false, false, false));
        // Fresh-database bootstrap and an identity that already holds the flag
        // keep working.
        assert!(resolve_admin_on_login(false, false, true));
        assert!(resolve_admin_on_login(false, true, false));
        // A bare identity token confers nothing: the flag is only ever written
        // on an authenticated login, and `sender_is_admin` also requires
        // `is_authenticated`.
    }

    #[test]
    fn demotion_only_counts_admins_from_other_accounts() {
        let rows = vec![
            ("admin@selfbase".to_string(), true),
            ("admin@selfbase".to_string(), true), // same account, other device
            ("plain@selfbase".to_string(), false),
        ];
        // Two devices of the only admin account: still one admin account, so
        // demotion must be refused rather than allowed by the sibling device.
        assert_eq!(count_admins_outside_account(rows.iter().map(|(e, a)| (e.clone(), *a)), "admin@selfbase"), 0);
        // Another account's admin keeps the workspace staffed.
        let rows = vec![
            ("admin@selfbase".to_string(), true),
            ("other@selfbase".to_string(), true),
        ];
        assert_eq!(count_admins_outside_account(rows.iter().map(|(e, a)| (e.clone(), *a)), "admin@selfbase"), 1);
        // Case-insensitive: emails are normalised, but never rely on it.
        let rows = vec![("Admin@Selfbase".to_string(), true)];
        assert_eq!(count_admins_outside_account(rows.iter().map(|(e, a)| (e.clone(), *a)), "admin@selfbase"), 0);
    }

    #[test]
    fn password_digest_verifies_current_domain() {
        let email = "user@test";
        let pw = "a sufficiently long password";
        let digest = current_password_digest(email, pw);
        let stored = harden_digest(&digest, "unique-salt");
        assert!(verify_password_digest(&stored, &digest));
        assert!(!verify_password_digest(&stored, &current_password_digest(email, "wrong")));
        assert!(!verify_password_digest(&stored, &current_password_digest("other@test", pw)));
        assert_ne!(stored, harden_digest(&digest, "another-salt"));
    }
    #[test]
    fn password_envelope_preserves_legacy_migration_without_accepting_wrong_password() {
        let digest = current_password_digest("user@test", "a sufficiently long password");
        let hardened = harden_digest(&digest, "unique-salt");
        assert!(verify_password_digest(&hardened, &digest));
        assert!(!verify_password_digest(&hardened, &current_password_digest("user@test", "wrong")));
        assert_ne!(hardened, harden_digest(&digest, "another-salt"));
    }
    #[test]
    fn oidc_requires_exact_issuer_and_audience() {
        let good = serde_json::json!({"iss":"https://trusted.test", "aud":["selfbase"]});
        assert!(trusted_oidc_claims(&good, "https://trusted.test", "selfbase"));
        assert!(trusted_oidc_claims(&good, "https://trusted.test", "selfbase-mobile, selfbase"));
        assert!(!trusted_oidc_claims(&good, "https://trusted.test", "selfbase-mobile"));
        assert!(!trusted_oidc_claims(&good, "https://trusted.test", ", ,"));
        assert!(!trusted_oidc_claims(&good, "https://attacker.test", "othercorp"));
        assert!(!trusted_oidc_claims(&good, "https://trusted.test", "other"));
        assert!(!trusted_oidc_claims(&serde_json::json!({"email":"admin@test"}), "https://trusted.test", "selfbase"));
    }
}
