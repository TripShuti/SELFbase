# SELFbase — Roadmap

Fork of Pear, stripped to the workspace core (Database → Row → Page).
Upstream's AI/agent/MCP/automation roadmap does not apply here and will not
be built. Historical upstream planning docs (`PEAR_MVP.md`, git history before
the `upstream-final` tag) are reference only.

## Shipped (fork baseline)

- Pages, databases (grid / list / board), relations, all non-AI property types
- Component-tree editor with Yjs rich text per block
- Snapshots + one-click restore, trash, access rules + human approval flow
- Attachments with authed presigned S3 upload/download
- Versioned REST API per database (`/api/e/{slug}`) with API keys + OpenAPI
- Snapshot v2 export/import, native + OIDC auth, Docker Compose (3 services)

## Removed vs upstream (intentional, will not return)

AI users/chats, Orcha, MCP server/client, extensions, automations, Notion
import, semantic search, AI columns, embeddings, device bridge, desktop app,
v1 snapshot import.

## Next (fork direction)

- [x] Human block comments (page + block-anchored threads, resolve, moderation)
- [ ] Markdown import/export
- [ ] Calendar / gallery views (schema exists, renderers missing)
- [ ] `selfbase upgrade` ergonomics (export → publish --clear → import)
- [ ] Production hardening: rate limits, backup docs
