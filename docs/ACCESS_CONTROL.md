# Page and conversation access control

> **Fork notice (SELFbase).** Upstream document; conversations/AI-user sections
> do not apply — this fork keeps pages, rules, and human-only access requests.

Introduced in module `1.0.0-beta.35`, addressing tasks 14437 and 333.

## Enforced boundary

A SpacetimeDB identity alone is not workspace membership. Page reads and writes
require an authenticated human, a provisioned AI identity, or the module
publisher. The first native account bootstraps the workspace; subsequent native
accounts must be created by an administrator. Logging out does not reopen
bootstrap registration. Only an administrator or publisher can provision AI
identities.

## Admin authority belongs to the account, not the device

`User.is_admin` is keyed by SpacetimeDB identity, and an identity lives in the
browser's localStorage — clearing storage, signing in from another machine or
reinstalling the browser mints a new one. Native admin authority therefore
lives on the account: `UserCredential.is_admin` is the record of record, and
`login` copies it onto whichever identity authenticates. Signing in on a new
device with an admin account yields an admin; a bare identity token never
conferred anything, since the check also requires `is_authenticated`.

One email may own several identities (every device that account signed in
from), so `set_user_admin` treats the email as the unit of administration: it
records the decision on the credential and cascades it to all of that account's
`User` rows, and refuses a demotion when no *other account* holds admin. OIDC
identities have no credential and are tracked by their `User` row alone.

Two publisher-only reducers exist for the locked-out case:
`backfill_credential_admin` migrates authority from pre-`is_admin` databases,
and `recover_admin` re-grants it when every admin identity is gone (it promotes
the most recently active authenticated user, or flags the newest credential
when nobody is signed in). Both refuse when an authenticated admin already
exists.

## Comment authorship belongs to the account, not the device

Block comments record their author the same way: `author` keeps the writing
identity (fast equality path, legacy rows), while the normalized email taken
from the author's authenticated `User` row is snapshotted into
`BlockComment.author_email` at write time. Editing, resolving and deleting a
comment previously required an *identity* match with the author — clearing
browser storage orphaned the user's own comments, leaving them editable only
by an admin and displayed as an unresolvable truncated identity (`bc542ff4…`
in the UI). `author_or_admin` now also accepts the caller whose authenticated
account email matches the snapshot, so a comment survives its author losing
that browser identity. New comments snapshot the email automatically;
legacy rows (and rows restored from snapshots exported before this column
existed) arrive with `author_email` empty and are repaired automatically by
the `block_comment_author_email_backfill_v2` step of `run_pending_migrations`
(invoked by the docker entrypoint after every publish). The publisher-only
`backfill_comment_authors` reducer re-runs the same link later for comments
whose author identity had no known email at migration time. Historical email
is retained on logout, so backfill includes logged-out `User` rows; authorization
still requires the caller to be authenticated. The v2 step repairs rows skipped
by the v1 session-state filter. Authors with no known email remain unlinked.

Page rules retain their existing semantics: no rule on the page or its ancestors
means open to workspace principals; otherwise an explicit ancestor/page grant
or an authenticated administrator is required. Write implies read. New child
pages inherit access dynamically, so revoking a parent's grant also affects its
children. Existing explicitly stored child grants are preserved: historical
copies are indistinguishable from deliberate grants and are not silently
removed during upgrade.

Private and participant conversations require active participation. Workspace
administrator status and access to the containing page do not confer private
conversation access. A page-inheriting thread is also visible to readers of its
page. A removed participant loses access unless the thread independently grants
it through page inheritance. Conversation mutation checks enforce the same
boundary; an unrelated administrator cannot self-add or expand a private thread.

The module publisher retains SpacetimeDB's administrative RLS bypass, as required
by backups and trusted worker operations. Do not give publisher credentials to
MCP clients or use them as a substitute for a caller's AI-user token.

## Implementation and compatibility

Four caller-scoped views compute readable page, component, schema, and
conversation IDs. Content tables join directly to these views. Page protection
includes component/Yjs content, attachment metadata, snapshots, schema/column
metadata, saved views, property values/history, evaluation output, memory-root
metadata, and API row markers. Conversation protection includes participants,
messages, attachments, and access-request records.

SpacetimeDB 2.0.3 accepts chained RLS joins for SQL reads but rejects their live
subscriptions. A tiny local fixture verified that joining a caller-scoped view
works for initial subscriptions and delivers removals when permissions change.
This follows the [RLS documentation](https://spacetimedb.com/docs/how-to/rls/),
with the actual query shapes verified against the pinned host.

An HTTP-only caller's first protected read must first evaluate the corresponding
view. `HttpStdbTransport` does this once per view per token-bound transport, using
a small `COUNT(*) AS count` query. View dependencies remain current after SQL
evaluation; raw SQL cannot reuse a revoked grant even without a WebSocket.
Initialization failures fail the requested read and can be retried. The transport
never falls back to an unscoped read. Direct SQL integrations should query the
appropriate `readable_*` view before their first protected-table read.

The views are derived state and excluded from snapshots. No existing content
rows are rewritten or deleted by this release. Views recompute from existing
identity, page, ACL, and participant rows. This is a page/conversation boundary
change, not a workspace-wide audit of unrelated operational tables.

## Validation

The access-control regression suite is self-contained: it starts a throwaway
SpacetimeDB standalone on a random localhost port with a temporary data
directory and generated JWT keys, publishes the candidate module to a unique
disposable database, and exercises snapshot import, page moves and subtree
deletion with synthetic identities. From the repository root:

```sh
python3 server/tests/access_control_regressions.py
# or run it with the rest of the integration suites (builds one candidate WASM):
python3 scripts/check.py integration
```

Formatting/type checks:

```sh
(cd server/spacetimedb && cargo test --locked --offline)
(cd web && pnpm test && pnpm exec tsc --noEmit)
```

The suite never touches a live workspace, production credentials or data.

## Rollout

Deploy as a coordinated module, bindings, web, gateway, and worker release.
The HTTP transport requires the new views, so deploying it against an older
module fails protected reads. Prepare host artifacts first, publish beta.35,
then activate the matching HTTP hosts and restart long-lived workers. Run the
usual post-publish migrations and verify a canary workspace before promotion.

SpacetimeDB 2.0.3 classifies this upgrade as client-breaking. Use lifecycle's
existing `POST /pre_publish` migration-plan flow and its returned token with
`PUT ?policy=BreakClients&token=...`; do not clear the database. An in-place
upgrade of the local pre-fix fixture preserved every existing page field and
blocked the previously reproducible anonymous read/write immediately afterward.

Canary acceptance: native/OIDC login, page editing, an AI reading its own memory,
denial for a different AI, private chat isolation, inherited grant/revocation,
and a real MCP read/write/read-back using caller credentials. Verify backup
export under the publisher identity. Any rollback must account for the fact that
an older module restores the original access-control exposure.

Local tests do not certify the production deployment, legacy grant cleanup,
OIDC issuer configuration, blob-store authorization, or workspace-scale
performance. These require the matching canary/operational checks.
