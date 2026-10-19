# PR #10 merge review

Reviewed base: `6954f54309d3cb23bffdc5bfe32796a2e92257d2` (`main`).
Original PR head: `345f2c10f4904bec0517b96fba7927f6a5c3436a`.

## Why the changes belong

The base artifact was exercised on a disposable standalone instance with
synthetic accounts. Crafted imports granted a foreign identity authenticated
admin authority (confirmed by an admin-only reducer call), accepted a known
API key and restored a public endpoint. Moving an inherited restricted page
to the root made it readable by another member; trashing an open ancestor also
trashed a child the caller could not write. These are reproduced defects.
The candidate denies these operations or preserves the relevant restrictions.

Other changes align mutation authority with current page access: endpoint
management rechecks the database; shared-column deletion/type conversion checks
pages holding current/history cells; creating saved history requires write.
The integration suite includes denied ordinary callers and successful
owner/admin operations. Native profile sync cannot replace account email with
caller-provided data. OIDC email requires `email_verified = true` in addition
to the existing issuer/audience checks; issuers omitting that claim no longer
supply profile email.

Personal-view editing checks ownership as well as page write. Current GridView
call sites create shared views, so this does not restrict those flows. Deep-link
host validation affects automatic workspace adoption, while manually configured
connections remain possible. Host additions are an explicit build-time setting.
Grid clearing removes values rather than manufacturing zero/false/text values;
unmounted rich-text merging preserves existing formatting.

Page writers already have authority to edit page access rules. Preserving grants
on move prevents accidental declassification; it does not make a writer unable
to deliberately change those rules. The module publisher remains trusted.

## Defects fixed during this review

- Body parsing now passes oversized and invalid JSON errors through the route's
  JSON error handler. Regression tests on the original PR throw instead of
  returning 413/400; the corrected route returns the expected responses.
- Endpoint cache hits recheck database existence/trash state before dispatch.
  Both cache regression cases returned 200 on the original PR and now return 404.
- The web Dockerfile declares and exports the allowlist build argument.
- Interactive permanent purge preflights write access for every trashed node.
  The original PR accepted an unauthorized ancestor purge; the corrected module
  refuses it before mutations. Empty-trash preserves that descendant; an admin
  can still purge. Scheduled retention retains its scheduler-only authorization.

## Validation

`python3 scripts/check.py all`: **PASS, 20/20 steps (623.3 seconds)**.
This includes 254 web tests, 210 editor tests, 25 Rust tests, TypeScript checks,
all six standalone integration suites, editor browser regressions, pinned-image
container upgrades, and the production Next.js build. The expanded access
suite also upgrades the exact PR base and verifies retained page/account state,
member login and allowed editing after upgrade.

A separate real Docker builder build passed with
`NEXT_PUBLIC_ALLOWED_WORKSPACE_HOSTS=review-allowed.example:3000` and an empty
`NEXT_PUBLIC_SPACETIMEDB_URI`. Running Node inside that image confirmed the host
literal exists in the generated browser JavaScript. Compose configuration also
preserved the empty URI, allowlist, OIDC arguments and `WEB_PULL_POLICY=always`.

The release WASM and `server/docker/server.wasm` have matching SHA-256:
`68a5fc2c84bd1b97197a44a69fd73609ecc830245e639e764e14189cab8d2c1b`.
No table/reducer signatures changed during the follow-up fixes.

Recommendation: merge the corrected PR. No remaining merge blockers were found
in the reviewed changes. The original head is superseded by these fixes.

## Deployment behavior

Snapshot restores skip API keys and force endpoints to require authentication;
reissue keys and explicitly reopen intended public endpoints. Existing imported
privileges or previously issued keys are not retroactively repaired by a code
upgrade. This review uses disposable instances and synthetic data; it does not
certify an operator's production OIDC configuration or migrate production secrets.
No production workspace or running deployment was modified.
