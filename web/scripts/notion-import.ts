/**
 * Generic Notion Markdown+CSV importer.
 *
 * Rebuilds a Notion database export in SELFbase via the HTTP API:
 *   - Database page + schema (column types from flags, default Text)
 *   - One row per CSV record (title column configurable)
 *   - Row body = matching Markdown file (title minus ` <32hex>` suffix):
 *     paragraphs become RichText blocks with real Yjs state
 *
 * CSV files that carry no body text (pure tables) work too — rows are
 * created with values and no blocks. Markdown files without a CSV row
 * become standalone Doc pages under the same container.
 *
 * Auth: publisher-capable token (reads/writes everything, no empty-DB
 * restriction). Provide SELFBASE_TOKEN, or it falls back to the local
 * Spacetime CLI token (~/.config/spacetime/cli.toml).
 *
 * Usage:
 *   pnpm --filter @selfbase/web import:notion -- \
 *     --csv "/path/Table.csv" --md "/path/export" --db "Table" \
 *     [--title-col "Назва"] [--select "Status,Priority"] [--number "Hours"] \
 *     [--skip "Date"] [--container "Notion Import"] [--dry-run]
 *
 * Env: SELFBASE_URL (default http://127.0.0.1:3000),
 *      SELFBASE_DB (default selfbase), SELFBASE_TOKEN.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import * as Y from "yjs";
import { plainTextToYDoc } from "@selfbase/pulp";

type Args = Record<string, string | boolean>;
function parseArgs(): Args {
  const out: Args = {};
  const raw = process.argv.slice(2).filter((a) => a !== "--");
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--dry-run") {
      out["dry-run"] = true;
      continue;
    }
    if (a === "--self-test") {
      out["self-test"] = true;
      continue;
    }
    if (a.startsWith("--")) {
      out[a.slice(2)] = raw[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

/** Minimal CSV parser (handles quotes, commas, BOM). */
function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c === "\r") {
      // skip, \n follows
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0]?.trim() !== "");
}

/** Split a Notion Markdown page into body paragraphs (title dropped). */
function parseMarkdown(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  const out: string[] = [];
  let seenBody = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!seenBody) {
      // Skip the title, blank lines and leading `Key: value` property lines.
      // Property values may contain colons, so only treat short keys as props.
      if (line.startsWith("# ")) continue;
      if (line.trim() === "") continue;
      const m = /^([^:\n]{1,40}):\s/.exec(line.trim());
      if (m) continue;
      seenBody = true;
    }
    if (line.trim() === "") continue;
    out.push(line.trim());
  }
  return out;
}

/** Notion sanitizes filenames (`:`, `/`, …) and collapses spaces — mirror
 * that on both sides so CSV titles match their Markdown files. */
export function normalizeTitle(s: string): string {
  return s
    .replace(/[:/\\?*<>|"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mdTitle(filename: string): string {
  return normalizeTitle(basename(filename, ".md").replace(/ [0-9a-f]{32}$/, ""));
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** SATS-JSON Option in row data: `[1, []]` (none) or `[0, value]` (some). */
function isNone(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v[0] === 1);
}

class Api {
  // NOTE on SpacetimeDB 2.0.3 HTTP wire shapes (empirically verified —
  // they differ from the {tag, value} snapshot envelope!):
  //   unit enums (PageType, PropertyType): lowercase {"variant": []},
  //     e.g. {"database": []}, {"select": []}
  //   payload enums (PropertyValue): lowercase {"variant": payload},
  //     e.g. {"text": "x"}, {"number": 1.5}, {"select": "Done"}
  //   Option<u64> args: JSON null works for none, but Some MUST be the
  //     [0, value] tuple (a bare integer is rejected); none is [1, []]
  //   Option<u64> in row data: [1, []] = none, [0, v] = some
  //   /call returns 200 with an empty body even when the reducer returns
  //   a value — always re-query for ids (parent_pk mirrors parent_id).
  constructor(
    readonly base: string,
    readonly db: string,
    readonly token: string
  ) {}

  async call<T>(reducer: string, args: unknown[]): Promise<T> {
    const res = await fetch(
      `${this.base}/v1/database/${encodeURIComponent(this.db)}/call/${reducer}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(args),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`reducer ${reducer} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const text = (await res.text().catch(() => "")).trim();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async sql<T>(query: string): Promise<T[]> {
    const res = await fetch(
      `${this.base}/v1/database/${encodeURIComponent(this.db)}/sql`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${this.token}`,
        },
        body: query,
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sql failed (${res.status}): ${text.slice(0, 300)} [${query.slice(0, 120)}]`);
    }
    const data = (await res.json()) as Array<{
      schema?: { elements?: Array<{ name?: { some?: string } }> };
      rows?: unknown[][];
    }>;
    if (!Array.isArray(data) || data.length === 0) return [];
    const cols = data[0].schema?.elements?.map((el) => el.name?.some ?? "") ?? [];
    return (data[0].rows ?? []).map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      return obj as T;
    });
  }
}

function readToken(): string {
  if (process.env.SELFBASE_TOKEN?.trim()) return process.env.SELFBASE_TOKEN.trim();
  try {
    const toml = readFileSync(join(homedir(), ".config", "spacetime", "cli.toml"), "utf8");
    const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) return m[1];
  } catch {
    // fall through
  }
  throw new Error("No token: set SELFBASE_TOKEN env (publisher-capable token required).");
}

const splitList = (v: string | boolean | undefined): string[] =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];


/** SATS-JSON Option<u64> for reducer args: null passes for none, but
 * Some must be the `[0, value]` tuple (a bare integer is rejected). */
function optId(id: number | null): null | [number, number] {
  return id === null ? null : [0, id];
}

async function findPageId(api: Api, parentId: number | null, title: string): Promise<number> {
  const pk = parentId ?? 0;
  const rows = await api.sql<{ id: number }>(
    `SELECT id FROM page WHERE parent_pk = ${pk} AND title = '${sqlEscape(title)}'`
  );
  if (rows.length === 0) throw new Error(`created page missing: ${title}`);
  return Math.max(...rows.map((r) => Number(r.id)));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const csvPath = args.csv as string;
  const mdDir = (args.md as string) ?? "";
  const dbName = (args.db as string) ?? "Notion import";
  const titleCol = (args["title-col"] as string) ?? "";
  const selectCols = splitList(args.select);
  const numberCols = splitList(args.number);
  const skipCols = splitList(args.skip);
  const containerName = (args.container as string) ?? "";
  const dryRun = args["dry-run"] === true;
  const selfTest = args["self-test"] === true;
  if (!csvPath && !mdDir && !selfTest) throw new Error("Required: --csv <path> and/or --md <dir> [--db <name>] [--dry-run]");

  const base = (process.env.SELFBASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const db = process.env.SELFBASE_DB ?? "selfbase";
  const token = readToken();
  const api = new Api(base, db, token);

  // ── Parse inputs ──
  type Record = { title: string; values: Map<string, string> };
  const records: Record[] = [];
  let header: string[] = [];
  if (csvPath) {
    const csvRows = parseCsv(readFileSync(csvPath, "utf8"));
    header = csvRows[0];
    const titleName = titleCol || header[0];
    const titleIdx = header.indexOf(titleName);
    if (titleIdx < 0) throw new Error(`Title column "${titleName}" not in CSV header: ${header.join(",")}`);
    for (const r of csvRows.slice(1)) {
      const values = new Map<string, string>();
      header.forEach((h, i) => {
        const v = (r[i] ?? "").trim();
        if (v !== "") values.set(h, v);
      });
      const title = (r[titleIdx] ?? "").trim();
      if (title === "") continue;
      records.push({ title, values });
    }
  }

  const bodies = new Map<string, string[]>();
  const mdFiles = mdDir ? readdirSync(mdDir).filter((x) => x.endsWith(".md")) : [];
  if (mdDir) {
    for (const f of mdFiles) {
      bodies.set(mdTitle(f), parseMarkdown(readFileSync(join(mdDir, f), "utf8")));
    }
  }
  // Match rows to files on normalized titles (Notion sanitizes filenames).
  const bodyFor = (title: string): string[] =>
    bodies.get(normalizeTitle(title)) ?? [];

  // Column plan from flags (default Text). Skipped: title + --skip.
  const titleName = titleCol || header[0];
  const columns: Array<{ name: string; kind: "select" | "number" | "text"; options?: string[] }> = [];
  for (const h of header) {
    if (h === titleName || skipCols.includes(h)) continue;
    if (selectCols.includes(h)) {
      const options = [...new Set(records.map((r) => r.values.get(h) ?? "").filter(Boolean))].sort();
      columns.push({ name: h, kind: "select", options });
    } else if (numberCols.includes(h)) {
      columns.push({ name: h, kind: "number" });
    } else {
      columns.push({ name: h, kind: "text" });
    }
  }

  const matched = records.filter((r) => bodyFor(r.title).length > 0).length;
  const orphanMd = [...bodies.keys()].filter((t) => !records.some((r) => normalizeTitle(r.title) === t));
  console.log(`CSV records: ${records.length}, MD files: ${bodies.size}, rows with body: ${matched}, orphan MD: ${orphanMd.length}`);
  if (orphanMd.length > 0) console.log("  orphan MD (become plain Doc pages):", orphanMd.slice(0, 10).join(" | "));
  console.log(`Columns: ${columns.map((c) => `${c.name}(${c.kind})`).join(", ") || "(none)"}`);
  if (dryRun) {
    console.log("DRY RUN — no writes.");
    return;
  }

  if (selfTest) {
    // Exercise the block-writing path end to end on a scratch page, then
    // remove it. Verifies insert_component + Yjs state round-trip.
    await api.call("create_page", [null, {"doc": []}, "IMPORT-SELFTEST"]);
    const _probe = await api.sql<{ id: number }>(
      `SELECT id FROM page WHERE parent_pk = 0 AND title = 'IMPORT-SELFTEST'`
    );
    const pid = Math.max(..._probe.map((r) => Number(r.id)));
    await writeBody(api, pid, "IMPORT-SELFTEST", [
      "First paragraph — plain text.",
      "Second paragraph with unicode: привіт, 9/10, №1.",
    ]);
    const nodes = await api.sql<{ id: number; component_type: string; deleted_at: unknown }>(
      `SELECT id, component_type, deleted_at FROM component_node WHERE surface_id = ${pid}`
    );
    const richIds = nodes
      .filter((x) => String(x.component_type) === "RichText" && (x.deleted_at == null || (Array.isArray(x.deleted_at) && x.deleted_at[0] === 1)))
      .map((x) => Number(x.id));
    if (richIds.length !== 2) throw new Error(`expected 2 RichText blocks, got ${richIds.length}`);
    const yjs = await api.sql<{ c: number }>(
      `SELECT COUNT(*) AS c FROM component_yjs_state WHERE component_node_id = ${Math.max(...richIds)}`
    );
    const yjsCount = Number(yjs[0]?.c ?? 0);
    console.log(`SELFTEST: 2 RichText blocks, last yjs present=${yjsCount === 1}`);
    if (yjsCount !== 1) throw new Error("yjs blob missing for last block");
    await api.call("delete_page", [pid]);
    console.log("SELFTEST PASSED, scratch page removed.");
    return;
  }

  // ── Container + database ──
  let parentId: number | null = null;
  if (containerName) {
    await api.call("create_page", [null, {"doc": []}, containerName]);
    parentId = await findPageId(api, null, containerName);
    console.log(`container page id=${parentId}`);
  }
  const existing = (
    await api.sql<{ id: number; deleted_at: unknown }>(
      `SELECT id, deleted_at FROM page WHERE title = '${sqlEscape(dbName)}'`
    )
  ).filter((r) => isNone(r.deleted_at));
  if (existing.length > 0) {
    throw new Error(`Database page "${dbName}" already exists. Delete it first for a clean import.`);
  }
await api.call("create_page", [optId(parentId), {"database": []}, dbName]);
  const dbId = await findPageId(api, parentId, dbName);
  console.log(`database page id=${dbId}`);

  await api.call("create_database_schema", [dbId, dbName]);
  const schemas = await api.sql<{ id: number }>(`SELECT id FROM database_schema WHERE page_id = ${dbId}`);
  const schemaId = Math.max(...schemas.map((r) => Number(r.id)));

  for (const col of columns) {
    const type = col.kind === "select" ? {"select": []} : col.kind === "number" ? {"number": []} : {"text": []};
    const config = col.kind === "select" ? JSON.stringify({ options: col.options ?? [] }) : "{}";
    await api.call("add_property", [schemaId, col.name, type, config]);
  }
  const propDefs = await api.sql<{ id: number; name: string }>(
    `SELECT id, name FROM property_definition WHERE schema_id = ${schemaId}`
  );
  const propId = (name: string): number => {
    const found = propDefs.find((p) => String(p.name) === name);
    if (!found) throw new Error(`property ${name} missing after add`);
    return Number(found.id);
  };

  // ── Rows ──
  let n = 0;
  for (const rec of records) {
await api.call("create_page", [optId(dbId), {"database": []}, rec.title]);
    const rowId = await findPageId(api, dbId, rec.title);
    for (const col of columns) {
      const raw = rec.values.get(col.name) ?? "";
      if (raw === "") continue;
      if (col.kind === "select") {
        await api.call("set_property_value", [rowId, propId(col.name), {"select": raw}]);
      } else if (col.kind === "number") {
        const num = Number.parseFloat(raw.replace(",", "."));
        if (!Number.isFinite(num)) continue;
        await api.call("set_property_value", [rowId, propId(col.name), {"number": num}]);
      } else {
        await api.call("set_property_value", [rowId, propId(col.name), {"text": raw}]);
      }
    }
    await writeBody(api, rowId, rec.title, bodies.get(rec.title) ?? []);
    n++;
    if (n % 20 === 0) console.log(`  …${n}/${records.length} rows`);
  }

  // ── Orphan MD files become plain Doc pages (even prop-only ones — the
  // title itself is worth keeping) ──
  let m = 0;
  for (const title of orphanMd) {
    const paras = bodies.get(title) ?? [];
    // Recover a displayable title (keys are normalized).
    const display =
      mdFiles.find((f) => normalizeTitle(mdTitle(f)) === title)?.replace(/ [0-9a-f]{32}\.md$/, "") ??
      title;
await api.call("create_page", [optId(parentId), {"doc": []}, display]);
    const pageId = await findPageId(api, parentId, display);
    await writeBody(api, pageId, display, paras);
    m++;
  }
  console.log(`DONE: database "${dbName}" (${dbId}) with ${n} rows + ${m} standalone docs.`);
}

async function writeBody(api: Api, pageId: number, title: string, paras: string[]): Promise<void> {
  if (paras.length === 0) return;
  const nodes = await api.sql<{ id: number; parent_id: number | null; component_type: string }>(
    `SELECT id, parent_id, component_type FROM component_node WHERE surface_id = ${pageId}`
  );
  const root = nodes.find((x) => isNone(x.parent_id));
  if (!root) throw new Error(`no root node for page ${title}`);
  const rootId = Number(root.id);
  for (const x of nodes) {
    if (Number(x.id) !== rootId && String(x.component_type) === "RichText") {
      await api.call("delete_component", [Number(x.id)]);
    }
  }
  let after: number | null = null;
  for (const text of paras) {
    await api.call("insert_component", [rootId, "RichText", "{}", after === null ? null : [0, after]]);
    const kids = await api.sql<{ id: number }>(
      `SELECT id FROM component_node WHERE surface_id = ${pageId}`
    );
    const newId = Math.max(...kids.map((k) => Number(k.id)));
    const doc = plainTextToYDoc(text);
    const bytes = Array.from(Y.encodeStateAsUpdate(doc));
    await api.call("save_component_yjs_state", [newId, bytes]);
    after = newId;
  }
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
