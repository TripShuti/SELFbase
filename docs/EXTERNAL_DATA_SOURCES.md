# External data sources

A database can connect to an HTTP JSON API without provider-specific SELFbase
code. The connection defines search/detail paths, JSON field selectors, a stable
record ID, authentication and column mappings. Selecting a result beside a row name
imports its mapped fields; a server worker refreshes links while browsers are
closed. A database can connect several reusable sources; each row links to exactly
one source. APIs may provide search/detail endpoints or a complete record collection.

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
6. Set title behavior, save and test the connection. Refresh schedules belong to
   the workspace source and are shared across its database connections.
7. In a new row, click **Untitled** or **Add from source**, search and select a
   record. Its name replaces Untitled when enabled; mapped fields are filled.
   For a named row, use the link icon; custom titles stay unchanged. The icon
   also opens **Refresh now** and **Unlink · keep values**. These actions are
   available in grid/list/board views and the row property panel.

Address, authentication and API field selectors belong to the workspace source.
Mappings, enabled state, title behavior and record links belong to each database.
The refresh schedule belongs to the workspace source. Editing a workspace source updates every connected database
atomically and rejects in-flight snapshots using the old definition. A source
cannot be removed while referenced by a database.

Existing database-local connections continue to work. Open their **Data source**
settings and choose **Make saved connection reusable**. This atomically moves
the saved private credential into the shared store, attaches the same database
and preserves all mappings, links and values. Other databases can then select
that source. Promotion uses the saved endpoint definition, not unsaved edits.
Select another workspace source and save to add a connection alongside existing
ones. In a row's link picker choose **Source**, then search. Changing a row's source
replaces its one link; sources never merge statistics for a row. Disconnecting a
source requires unlinking its rows first; saved values remain.

Selectors support own-property dot paths and numeric array indexes, e.g.
`data.items`, `stats.total` or `items.0.name`; JSONPath expressions are not used.
Only the first 50 matches are displayed. In search/detail mode configure an upstream
limit when supported. In **Collection** mode SELFbase fetches the whole configured
array and searches it locally before applying that display limit. Detail paths and
search query parameters are unnecessary for a collection.

## Values, ownership and refresh

- A link stores `{ "id": "stable-id", "label": "Display name", "sourceId": "source-id" }` internally.
  Old links without sourceId continue to use the original connection.
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
  strings are valid values. Date mappings optionally treat zero as an absent
  timestamp, avoiding January 1970 for APIs that use zero for never played.
  Invalid conversions reject the whole row refresh.
- Selecting a different ID clears the previous record's mapped values so that
  unavailable new fields cannot display statistics from the previous record.
  Unlinking retains values as an ordinary snapshot.
- All mapped values are applied in one reducer transaction. Rebinding, disabling
  or changing the connection while a request is in flight rejects the stale
  response. Unchanged values do not append duplicate history.
- Background refresh runs in the persistent Next.js Node server. It checks due
  sources every minute. Choose Manual only, Hourly, Every 6 hours (default), Daily
  or a custom interval from 60 to 604800 seconds. A source is scheduled once across
  its connected databases. In change mode a lightweight status request checks a
  successful revision; records refresh only for a new revision or changed mappings.
  Upstream requests have a 15-second timeout, redirects are rejected, responses
  are limited to 2 MB. Identical requests are shared across databases in a cycle.
  Collection snapshots are bounded (32 sources, 20,000 records per array) and kept
  only in web-server memory with interval-based expiry and concurrent-request
  deduplication. Restarting web drops this cache; no raw API cache is written to
  SpacetimeDB or snapshots. Manual refresh invalidates the source cache.
  Errors retain existing data and retry with backoff. Deleted/unlinked
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

## Conditional Select statuses and manual labels

For a Select destination, choose **Status from rules**. The source field points
to the object whose absence should preserve existing data (for example
`state`). Conditions use paths from the detail record root, not relative to
that object. Related-date lookups enrich their configured source field before
rules run, so activity in a child record can set the parent to In progress. Rules run in order and the first match supplies the label:

| Condition field | Operator | Value | Result |
| --- | --- | --- | --- |
| `state.complete` | Equals | `true` | Completed |
| `state.progress` | Greater than | `0` | In progress |

Set **When no rule matches** to a fallback such as Not started, or leave it
blank to keep the current value. An absent source object never manufactures a
fallback state. Equality compares scalar text representations (`true`, `false`,
numbers or strings); Has a value ignores null, missing and empty strings.

**Manual labels to keep** protects exact Select values, for example Dropped or
Paused. The reducer checks the current saved cell transactionally before any
worker/manual refresh write, so a manual edit made while HTTP is in flight is
protected too. Choose a different label to resume synchronization. Relinking
to a different external record still clears the old record's mapped statistics.

To convert an existing Checkbox, change its column type to Select, then open
Data source and configure status rules for that destination. Saving adds rule,
fallback and protected labels to its Select choices. Existing column values
use the standard type-conversion history until the next successful refresh.

## Latest date from related records

For a Date mapping, expand **Latest date from related records** and enable it.
Configure a same-source path containing `{id}`, the result array path, and the
date field in each related record. Optional **Only when field/value** conditions
apply the lookup to selected types; other types keep using the primary field.
The transform is **ISO date → date**.

For paginated APIs configure offset/limit query parameter names, page size and
optionally the total-count field. With a total count all records must be read;
without one a short page ends the list. Leave both parameter names blank only
for APIs that return an entire collection in one response. Requests retain the
source's origin/authentication, timeout, redirect and response-size protections.
Up to 20 pages of at most 500 records are requested. Errors, invalid dates,
incomplete collections and limit overflows reject the row snapshot; no partial
status/date is committed. Empty/null dates preserve existing values.

The saved date is the maximum of the primary date and all related dates. This
is a latest recorded timestamp, not necessarily a completion timestamp.

Example Jellyfin configuration (no provider-specific SELFbase code):

- Status source field: `UserData`; rules: `UserData.Played = true` →
  Переглянуто, then `UserData.PlayedPercentage > 0`,
  `UserData.PlaybackPositionTicks > 0` or an existing
  `UserData.LastPlayedDate` → В процесі; fallback Не розпочато.
- Protected manual label: Дроп.
- Date source field: `UserData.LastPlayedDate`.
- Related path:
  `/Items?parentId={id}&recursive=true&includeItemTypes=Episode&userId=USER_ID&enableUserData=true`.
- Array: `Items`; date field: `UserData.LastPlayedDate`.
- Condition: `Type` equals `Series`. Films use the primary date.
- Offset/limit parameters: `startIndex` / `limit`; total field:
  `TotalRecordCount`; page size: 200.

These are per-database mapping settings and are included in workspace snapshots
and copied mappings. Existing HTTP sources continue to work unchanged. No table
layout changes or data deletion are required by this feature.

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


## Steam library using the generic collection mode

Create a workspace source with these settings; no Steam-specific SELFbase code
or additional service is required:

| Setting | Value |
| --- | --- |
| Base URL | `https://api.steampowered.com` |
| Record lookup | Collection |
| Collection/search path | `/IPlayerService/GetOwnedGames/v1/?input_json={"steamid":"STEAMID64","include_appinfo":true,"include_played_free_games":true}` |
| Results array | `response.games` |
| Record ID | `appid` |
| Record label | `name` |
| Authentication header | `x-webapi-key` |
| Authentication prefix | Empty |
| Credential | Your private Steam Web API key |
| Refresh schedule | Every 6 hours |

Replace STEAMID64 with your account's numeric ID. The server URL encoder handles
the JSON query value. Map `playtime_forever` to a Duration column using **As
provided** (Steam already returns minutes). Map `rtime_last_played` to Date using
**Unix seconds → date**, with **Treat a zero timestamp as missing** enabled. First
played dates and achievement progress are not promised by this library endpoint.
Steam privacy settings must permit access to the game library. A missing result
array is an error and preserves saved values.

Official references: [GetOwnedGames](https://partner.steamgames.com/doc/webapi/IPlayerService#GetOwnedGames),
[Web API authentication](https://partner.steamgames.com/doc/webapi_overview/auth).
The API key is entered once in the private credential field, never in a URL.

## psnself refresh after completed sync

For an existing psnself workspace source, choose **When source status changes**,
check **Hourly**, and set:

| Setting | Value |
| --- | --- |
| Status API path | `/api/v1/status` |
| Completed revision field | `last_sync.finished_at` |
| Success field | `last_sync.status` |
| Success value | `success` |

All its databases share this check. Running/failed syncs and unchanged successful
revisions do not trigger record requests. The first successful check after a web
restart refreshes linked records. Manual refresh remains available.


## Record image URLs

Keep **Image URL field** for APIs returning a complete HTTP(S) URL, such as
psnself's `cover_url`. No change to existing sources is needed.

For APIs returning image identifiers or hashes, set the optional **Image URL
template**. For example:

```text
https://images.example.com/{item.id}/{art.hash}.jpg
```

Placeholders are own-property dot paths from the record. Values are URL-encoded;
they cannot change the fixed image host. If a required field is missing, null or
empty, the direct image URL field is used as a fallback; otherwise no image is
shown. Templates contain URLs and fields only, without executable expressions.
Changing a shared template updates all its database connections and selects a
new in-memory collection cache entry. Authentication credentials remain private
and are never attached to image requests. Images are fetched by the browser.

For Steam's `GetOwnedGames` response, use:

```text
https://media.steampowered.com/steamcommunity/public/images/apps/{appid}/{img_icon_url}.jpg
```

This displays the game's icon returned by the library API, not a full-sized
store cover. Steam icons without a hash remain empty. Leave **Image URL field**
blank when using this template.

## Additional API lists

A source can attach up to four other complete API lists to its main records.
In **Settings → Data sources**, edit the source, expand **Additional API lists**
and choose **+ Add API list**. Set:

- **Additional API path**: a path on the same source, such as `/activity`.
- **Additional results array**: the dot path to the complete array; blank for a
  root array. Pagination is not performed for these lists.
- **Main record match field** and **Additional record match field**: ID paths in
  the respective records. Numeric and string representations of the same ID match.
- **Attach as field**: a unique top-level namespace, such as `activity`.

The matched record becomes available at `activity.field_name` for mappings,
status rules, image selectors and image templates. Existing main record fields
are never overwritten. Missing matches leave extra fields absent, so missing/null
values preserve saved destination cells. Duplicate additional IDs, invalid
responses, HTTP failures or namespace collisions reject the snapshot; no partial
row update is written. Empty complete arrays are valid. Relinking still clears
old mapped values as before.

Both collection and search/detail sources support additional lists. Lists share
the source's origin, private authentication, schedule and bounded in-memory cache.
A new primary collection snapshot fetches its additional lists together; requests
are coalesced across connected databases. Manual refresh invalidates both caches.
Each additional response is limited to 2 MB and 20,000 records. Indexed additional
lists have a separate 128-entry memory bound. No API response cache is stored in
SpacetimeDB. Settings are stored and exported alongside the source definition;
no database table layout change or rebinding is required.

### Steam first played date

Keep the existing GetOwnedGames collection and add:

| Setting | Value |
| --- | --- |
| Additional API path | `/IPlayerService/ClientGetLastPlayedTimes/v1/?input_json={"min_last_played":0}` |
| Additional results array | `response.games` |
| Main record match field | `appid` |
| Additional record match field | `appid` |
| Attach as field | `play_history` |

Map `play_history.first_playtime` to a Date column with **Unix seconds → date**
and **Treat a zero timestamp as missing**. This is the first played timestamp
reported by Steam, not the acquisition date. The endpoint refers to the account
owning the API key; configure the main library for that same account. Some games
have no matching history. Existing names, icons and lifetime playtime continue
using GetOwnedGames. This undocumented endpoint was verified with an ordinary
Web API key; no separate Steam session token was needed.

Live validation joined first played dates to a real Steam library without database
writes. Local regression checks cover missing matches,
zero dates, failed/ambiguous lists, concurrent fetches, shared database refresh,
cache expiry/invalidation, native validation and browser configuration.
