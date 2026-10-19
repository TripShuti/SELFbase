# Editor autosave recovery

Run all regular checks from the repository root with `pnpm check`, or only
editor unit tests with `pnpm --filter @selfbase/pulp test`. See
[the shared test guide](../../../docs/TESTING.md) for full and individual profiles.

The browser regression uses real Chromium IndexedDB and a simulated reducer:

```sh
pnpm check:browser
```

Playwright is pinned in the root development dependencies. Install Chromium with
`pnpm exec playwright install chromium`, or set `PLAYWRIGHT_MODULE` to an existing
Playwright module. The runner bundles the production document autosave and scoped-subscription hooks using
the workspace test toolchain and serves it on a temporary localhost port. It
tests offline recovery after remount, reconnect, updated reducer callbacks,
failed-request retries, absence of server echoes, concurrent snapshot repair,
reconnect with an unresolved old reducer, and delayed subscription hydration.
It also verifies readiness resets synchronously for a new connection or scope,
ignores old subscription callbacks, and waits for fallback subscriptions.
The SDK connection provider is simulated; React effects and IndexedDB are real.
It does not require a running SELFbase backend.

Autosave follows the editable Y.Doc rather than its ProseMirror view. Local
updates are written to IndexedDB; server writes normally wait up to 30 seconds.
Only a successful reducer response acknowledges a captured revision. Writes are
serialized within a connection and transient failures retry with exponential
delay capped at 30 seconds. Disconnect invalidates pending acknowledgements from the old socket,
including SDK promises that never settle. Reconnect waits for the current
subscriptions to apply and merges their server snapshot before saving.
Reconnect and page lifecycle events
also attempt a flush. Remote echoes do not trigger another write; a server snapshot missing local content or
deletions schedules a merged replacement.

Browser shutdown cannot guarantee completion of an asynchronous server request.
Recovery depends on the local IndexedDB write having committed and the browser
retaining that database. Snapshot reconciliation requires at least one client
with the missing updates to reconnect; it is not server-side CRDT merging.
