# SELFbase

**A self-hosted, relational-first workspace: Database → Row → Page — built on SpacetimeDB.**

Fork of [Pear](https://codeberg.org/Eclosion-Tech/pear) (AGPL-3.0, fork point tagged `upstream-final`),
stripped down to the workspace core: pages, databases, relations, files, and a
versioned REST API. No AI users, no agents, no MCP, no Notion import, no
automations, no worker. Pages and database rows are the same entity — a page
viewed in a grid is a row, a row opened fully is a page. Real-time sync over
SpacetimeDB subscriptions; documents are typed component trees with Yjs-backed
rich text.

## Stack

| Layer | Technology |
|---|---|
| Backend / sync | [SpacetimeDB](https://spacetimedb.com) (Rust module) |
| Frontend | Next.js · React 19 · Tailwind CSS 3 |
| Editor | Component-tree editor (`packages/snapshot-core` + `packages/pulp`) — typed `ComponentNode` rows in SpacetimeDB, per-block Yjs rich text |
| Auth | Native SpacetimeDB email/password (default) · Any OIDC provider (optional) |
| Attachments | S3-compatible storage (Garage in Docker Compose by default) |
| Containerisation | Docker Compose (3 services: SpacetimeDB, web, Garage) |

## Features

- **Pages & documents** — nesting, icons, breadcrumbs, trash with restore, snapshot history with one-click restore, audio/image/code blocks.
- **Databases** — grid, list & board views; Text, Number, Date, Select, Multi-select, Checkbox, URL, Relation, Person, File, Formula, Rollup columns; inline editing, filters, sorts; any row opens as a full page with its own URL.
- **Relations** — first-class links between databases.
- **Access control** — per-page/per-block rules (open by default), access requests with human approval.
- **Files** — presigned S3 upload/download, metadata in SpacetimeDB.
- **REST API** — expose any database as a versioned REST API (`/api/e/{slug}`) with API-key auth and OpenAPI spec. See [`docs/API_ENDPOINTS.md`](./docs/API_ENDPOINTS.md).
- **Backup** — export/import the workspace as a `selfbase-snapshot-v2` JSON file from settings.

What this fork deliberately does **not** have (see upstream Pear if you need
them): AI users, agent chats, Orcha orchestration, MCP server/client,
extensions, automations, Notion import, semantic search, AI columns,
device bridge, desktop app.

## Project structure

```
./
├── server/
│   ├── spacetimedb/src/   # Tables, reducers (lib.rs + modules)
│   ├── docker/            # entrypoint.sh, garage.toml, garage-init.sh
│   └── spacetime.json     # TS bindings output dir (web/src/module_bindings)
├── web/                   # Next.js app
├── packages/
│   ├── pulp/              # Component-tree editor library
│   └── snapshot-core/     # Snapshot v2 format (export/import)
├── extensions/            # (legacy, unused)
├── docs/                  # API_ENDPOINTS.md, ACCESS_CONTROL.md, security reviews
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## Getting started

Prerequisites: Docker + Docker Compose, plus Rust (`wasm32-unknown-unknown`
target) and the SpacetimeDB CLI for the one-time module build.

```bash
# 1. Build the database module (once)
cd server && spacetime build && cd ..

# 2. Configure
cp .env.example .env   # adjust S3 secrets (≥16 chars), URIs

# 3. Start
docker compose up -d --build
```

| Service | URL |
|---|---|
| SpacetimeDB | `http://localhost:3000` |
| Web client | `http://localhost:3001` |

Open the web client and register — the first user becomes admin.
`NEXT_PUBLIC_*` values are baked into the web bundle at build time; rebuild
the web image after changing them.

## Development (without Docker)

```bash
spacetime start

cd server/spacetimedb
cargo build --release --target wasm32-unknown-unknown
cd ..
spacetime publish -s local selfbase-dev
spacetime call -s local --yes selfbase-dev run_pending_migrations

# new shell, repo root:
pnpm install
pnpm --filter @selfbase/web dev   # → http://localhost:3001
```

After any change under `server/spacetimedb/src/`, regenerate bindings:

```bash
cd server && spacetime generate
```

## Authentication

Default — native SpacetimeDB email/password, zero config. Optional — any OIDC
provider via `NEXT_PUBLIC_AUTH_MODE=oidc`, `NEXT_PUBLIC_OIDC_AUTHORITY`,
`NEXT_PUBLIC_OIDC_CLIENT_ID`; the ID token must carry `email`, `name`, or
`preferred_username`.

## Backend API surface

Source of truth: `server/spacetimedb/src/` — all `#[reducer]` functions and
`#[table]` definitions. Groups: auth, pages & Yjs, component tree, snapshots,
attachments, database schema/values/views, access control, custom API
endpoints, snapshot import. Client call sites use generated bindings under
`web/src/module_bindings/`.

## License

[AGPL-3.0](LICENSE) — same as upstream. Network use of a modified version
requires offering the corresponding source to users (§13).
