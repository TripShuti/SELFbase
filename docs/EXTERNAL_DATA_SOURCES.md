# External data sources

A database can connect to an HTTP JSON API without provider-specific SELFbase
code. The connection defines search/detail paths, JSON field selectors, a stable
record ID, authentication and column mappings. Selecting a result in a link cell
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

## Connect a database

1. Create destination columns with suitable types (Text, Number, Duration, Date,
   Checkbox, URL, Select or MultiSelect).
2. As a workspace admin, open **Data source** beside the database title.
3. Enter the source name and base URL. Configure:
   - Search path and search query parameter.
   - Dot path to the search result array; leave blank for a root array.
   - Single-record path containing `{id}` and optional result-object path.
   - Stable ID and display-name paths shared by search/detail records.
   - Optional subtitle and image URL paths.
4. Set the authentication header, prefix and credential. For bearer auth use
   `Authorization`, prefix `Bearer ` (including the space), and the raw API key.
   For an API-key header use e.g. `X-API-Key` with an empty prefix. Leave the
   header name blank for an unauthenticated API.
5. Create a dedicated link column (the default) or select a Text column. Map
   source fields to destination columns and choose transforms where needed.
   Each target can be mapped once. The link column is reserved for the selector.
6. Save, then **Test saved connection**. In a row's link cell, search and select
   the desired record. You can also **Refresh now** or **Unlink · keep values**.

Selectors support own-property dot paths and numeric array indexes, e.g.
`data.items`, `stats.total` or `items.0.name`; JSONPath expressions are not used.
Only the first 50 search results are displayed, so configure an upstream limit
in the search path when the API supports one.

## Values, ownership and refresh

- A link stores `{ "id": "stable-id", "label": "Display name" }` in a Text
  cell. The ID controls synchronization; renaming a row does not break it.
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
  are limited to 2 MB, and each distinct record is fetched once per source/cycle.
  Errors retain existing data and retry at the next interval. Deleted/unlinked
  rows are skipped. Connection status reports the last background check/errors.
- Source freshness depends on the upstream service. Frequent SELFbase checks
  cannot make a source's own collection of data more frequent.

Administrators configure networking and credentials. Ordinary authenticated users
with page write access may select/refresh records. Search requires read access
to the database. The Next.js route validates the caller's SpacetimeDB token and
page ACLs before using the owner token to read credentials. Worker writes also
validate the saved mapping, revision and current link inside the reducer.

Credentials live in the private `external_source_secret` table. They are absent
from client tables and JSON workspace exports. Configuration and links are
included in existing schema/property exports; after restoring a JSON export,
re-enter authenticated-source credentials. A database-volume backup preserves
private credentials. Editing the base URL or auth header requires re-entering
the credential, preventing accidental reuse with a new destination.

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
rejected stale writes, and private-credential/admin boundaries. Test scripts are
kept locally and excluded from deployment commits.
