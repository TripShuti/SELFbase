# Editor autosave recovery

Run unit tests with `pnpm --filter @selfbase/pulp test`.

The browser regression uses real Chromium IndexedDB and a simulated reducer:

```sh
node packages/pulp/tests/autosave-browser.mjs
```

Install Playwright with Chromium first, or set `PLAYWRIGHT_MODULE` to an existing
Playwright module. The runner bundles the actual document autosave hook using
the workspace test toolchain and serves it on a temporary localhost port. It
tests offline recovery after remount, reconnect, updated reducer callbacks,
failed-request retries, absence of server echoes, concurrent snapshot repair, and reconnect with an unresolved old reducer.
It does not require a running SELFbase backend.

Autosave follows the editable Y.Doc rather than its ProseMirror view. Local
updates are written to IndexedDB; server writes normally wait up to 30 seconds.
Only a successful reducer response acknowledges a captured revision. Writes are
serialized within a connection and transient failures retry with exponential delay capped at 30
seconds. Disconnect invalidates pending acknowledgements from the old socket,
including SDK promises that never settle. Reconnect and page lifecycle events also attempt a flush. Empty remote
echoes do not trigger another write; a server snapshot missing local content or
deletions schedules a merged replacement.

Browser shutdown cannot guarantee completion of an asynchronous server request.
Recovery depends on the local IndexedDB write having committed and the browser
retaining that database. Snapshot reconciliation requires at least one client
with the missing updates to reconnect; it is not server-side CRDT merging.
