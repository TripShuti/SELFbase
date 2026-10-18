# External data sources

A database can connect to an HTTP JSON API without provider-specific SELFbase
code. The connection defines search/detail paths, JSON field selectors, a stable
record ID, authentication and column mappings. Selecting a result beside a row name
imports its mapped fields; a server worker refreshes links while browsers are
closed. This first version supports one source per database and GET-based search
and detail APIs.

## Server setup (Docker / Dockhand)

Set `SELFBASE_STDB_TOKEN` on the SELFbase stack to the **existing database
owner's SpacetimeDB token**. The web service uses it to read private source
credentials and refresh rows. The compose file forwards it to the web container;
it is never a `NEXT_PUBLIC_*` setting. Do not generate a new database owner.
To view the existing container login privately, use:

```sh
docker exec selfbase-spacetimedb spacetime login show --token
```

Copy its auth token into the stack's environment/secret settings. Do not commit
it to Git. `SELFBASE_STDB_URL` defaults to `http://spacetimedb:3000` and the database
name follows `SPACETIMEDB_DB_NAME`. `EXTERNAL_SOURCE_SYNC_ENABLED=false` disables
background refresh while retaining manual refresh.

The base URL must be reachable **from the web container**, not just the browser.
`http://host.docker.internal:<port>` reaches a service published on the same
Docker host; compose supplies the Linux host-gateway alias. A shared Docker
network and its service DNS name work too.

## Workspace sources and database connections

1. As a workspace admin, open **Settings → Data sources → + New Source**.
2. Enter the source name, base URL, search/detail paths and JSON selectors.
   Detail paths contain `{id}`; search/detail records share ID and label paths.
   Search results may be a root array or an array at a configured dot path.
3. Set the authentication header, prefix and credential. For bearer auth use
   `Authorization`, prefix `Bearer ` (including the space), and the raw API key.
   For a public API leave the header name blank. Save the workspace source once.
4. In a database, create destination columns, then open **Data source** beside
   its title and choose the saved **Workspace source**. No credential is needed.
5. Map source fields to destination columns and select value transforms.
   **Copy mappings from another database** matches column names and types and
   skips missing or ambiguous matches. Review the result before saving.
6. Set this database's interval and title behavior, save and test the connection.
7. In a new row, click **Untitled** or **Add from source**, search and select a
   record. Its name replaces Untitled when enabled; mapped fields are filled.
   For a named row, use the link icon; custom titles stay unchanged. The icon
   also opens **Refresh now** and **Unlink · keep values**. These actions are
   available in grid/list/board views and the row property panel.

Address, authentication and API field selectors belong to the workspace source.
Mappings, enabled state, title behavior, intervals and record links belong to
each database. Editing a workspace source updates every connected database
atomically and rejects in-flight snapshots using the old definition. A source
cannot be removed while referenced by a database.

Existing database-local connections continue to work. Open their **Data source**
settings and choose **Make saved connection reusable**. This atomically moves
the saved private credential into the shared store, attaches the same database
and preserves all mappings, links and values. Other databases can then select
that source. Promotion uses the saved endpoint definition, not unsaved edits.
When switching an already-linked database to a different source, unlink its
records first to avoid interpreting one provider's IDs as another provider's.

Selectors support own-property dot paths and numeric array indexes, e.g.
`data.items`, `stats.total` or `items.0.name`; JSONPath expressions are not used.
Only the first 50 search results are displayed, so configure an upstream limit
in the search path when the API supports one.

## Values, ownership and refresh

- A link stores `{ "id": "stable-id", "label": "Display name" }` internally.
  The ID controls synchronization; renaming a row does not break it. Existing
  link-property data remains intact for backward compatibility, but the property
  is hidden from grids, lists, boards and row property panels. No schema migration
  or rebinding is needed. It remains included in exports and background refresh.
- Only configured destination columns are written. User notes, ratings and other
  columns are untouched. Optionally, the source name fills an empty/`Untitled`
  row title; existing titles remain user-owned.
- Supported transforms: identity, seconds/milliseconds/hours to minutes,
  ISO date to epoch milliseconds, and Unix seconds to epoch milliseconds.
  Duration cells store whole minutes; Date cells store epoch milliseconds.
- Missing/null source fields preserve existing values. Zero, false and empty
  strings are valid values. Invalid conversions reject the whole row refresh.
- Selecting a different ID clears the previous record's mapped values so that
  unavailable new fields cannot display statistics from the previous record.
  Unlinking retains values as an ordinary snapshot.
- All mapped values are applied in one reducer transaction. Rebinding, disabling
  or changing the connection while a request is in flight rejects the stale
  response. Unchanged values do not append duplicate history.
- Background refresh runs in the persistent Next.js Node server. It checks due
  connections every minute; intervals are configurable from 60 to 86400 seconds.
  Upstream requests have a 15-second timeout, redirects are rejected, responses
  are limited to 2 MB, and each distinct record is fetched once per database/cycle.
  Errors retain existing data and retry at the next interval. Deleted/unlinked
  rows are skipped. Connection status reports the last background check/errors.
- Source freshness depends on the upstream service. Frequent SELFbase checks
  cannot make a source's own collection of data more frequent.

Administrators configure networking and credentials. Ordinary authenticated users
with page write access may select/refresh records. Search requires read access
to the database. The Next.js route validates the caller's SpacetimeDB token and
page ACLs before using the owner token to read credentials. Worker writes also
validate the saved mapping, revision and current link inside the reducer.

Shared credentials live in the private `shared_external_source_secret` table;
legacy connections retain `external_source_secret` until promoted. Workspace
source definitions use reserved `external-source.*` entries in `workspace_setting`,
already included in the portable snapshot format. They are absent
from client tables and JSON workspace exports. Definitions, configuration and links are
included in workspace settings and schema/property exports; after restoring a JSON export,
re-enter each shared source credential once in Settings → Data sources. A database-volume backup preserves
private credentials. Editing a shared source's base URL, auth header or prefix requires re-entering
the credential. Credentials are bound to that endpoint/authentication scope,
including after a snapshot restore, to prevent reuse with another destination.
The only added table is private; existing public table layouts are unchanged.

## Example: connect psnself

This is configuration only; SELFbase has no PSN-specific code. Deploy the psnself
read API, set its `PSNSELF_API_KEY`, then use that key in the generic connection:

| Setting | Value |
| --- | --- |
| Base URL | `http://host.docker.internal:8420` (use your published port) |
| Search path | `/api/v1/games?limit=20` |
| Query parameter | `q` |
| Results array path | `games` |
| Single-record path | `/api/v1/games/{id}` |
| Single-record result path | blank |
| ID / display name | `id` / `name` |
| Subtitle / image | `platform` / `cover_url` |
| Header / prefix | `Authorization` / `Bearer ` |

Example field mappings:

| Source field | Destination type | Transform |
| --- | --- | --- |
| `playtime_seconds` | Duration | Seconds → minutes |
| `progress` | Number | As provided |
| `last_played` | Date | ISO date → date |
| `play_count` | Number | As provided |
| `platform` | Text | As provided |
| `cover_url` | URL | As provided |
| `earned_platinum` | Number | As provided |

psnself searches its already-synced library and reports the latest locally known
statistics. SELFbase never needs the Sony NPSSO cookie.

## Validation

Local checks cover generic mapping/HTTP behavior, two unrelated response shapes,
real SpacetimeDB 2.0.3 upgrade and synchronization, preservation of existing
records and notes, unit conversion, null/zero handling, idempotent history,
rejected stale writes, private-credential/admin boundaries, shared-key reuse by two databases, promotion
without data loss, propagated edits and browser-based source management. Test scripts are
kept locally and excluded from deployment commits.
