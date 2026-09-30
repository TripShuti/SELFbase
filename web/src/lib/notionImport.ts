"use client";

/**
 * Generic Notion Markdown+CSV import core (shared by the CLI script and the
 * in-app importer). Pure parsing/planning plus a transport-driven runner —
 * pass any StdbTransport (publisher token for scripts, user token in browser).
 *
 * SATS-JSON wire shapes for reducer args (SpacetimeDB 2.0.3 HTTP, verified):
 * unit enums are lowercase `{"variant": []}` ({"database": []}, {"select": []}),
 * payload enums are lowercase `{"variant": payload}` ({"text": s}), and
 * Option<u64> is null for none but MUST be `[0, v]` for some.
 */

import * as Y from "yjs";
import { plainTextToYDoc } from "@selfbase/pulp";
import type { StdbTransport } from "@/src/lib/api-endpoint";

export type NotionColumnKind = "select" | "number" | "text";

export interface NotionColumn {
  name: string;
  kind: NotionColumnKind;
  options?: string[];
}

export interface NotionPlan {
  records: Array<{ title: string; values: Map<string, string> }>;
  bodies: Map<string, { display: string; paras: string[] }>;
  columns: NotionColumn[];
  matched: number;
  orphans: string[];
}

/** Minimal CSV parser (handles quotes, commas, BOM). */
export function parseCsv(text: string): string[][] {
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

/** Notion sanitizes filenames (`:`, `/`, …) and collapses spaces — mirror
 * that on both sides so CSV titles match their Markdown files. */
export function normalizeTitle(s: string): string {
  return s
    .replace(/[:/\\?*<>|"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function mdTitle(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  return normalizeTitle(base.replace(/\.md$/, "").replace(/ [0-9a-f]{32}$/, ""));
}

/** Split a Notion Markdown page into body paragraphs (title dropped). */
export function parseMarkdown(text: string): string[] {
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

export interface PlanInputs {
  csvText?: string;
  mdFiles?: Array<{ name: string; text: string }>;
  dbName: string;
  titleCol?: string;
  selectCols?: string[];
  numberCols?: string[];
  skipCols?: string[];
}

/** Build an import plan from raw inputs (no I/O, no writes). */
export function buildNotionPlan(inputs: PlanInputs): NotionPlan {
  const {
    csvText,
    mdFiles = [],
    titleCol,
    selectCols = [],
    numberCols = [],
    skipCols = [],
  } = inputs;

  type Record = { title: string; values: Map<string, string> };
  const records: Record[] = [];
  let header: string[] = [];
  if (csvText) {
    const csvRows = parseCsv(csvText);
    header = csvRows[0] ?? [];
    const titleName = titleCol || header[0];
    const titleIdx = header.indexOf(titleName);
    if (titleIdx < 0) throw new Error(`Title column "${titleName}" not in CSV header.`);
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

  const bodies = new Map<string, { display: string; paras: string[] }>();
  for (const f of mdFiles) {
    const display = f.name.replace(/\.md$/, "").replace(/ [0-9a-f]{32}$/, "");
    bodies.set(mdTitle(f.name), { display, paras: parseMarkdown(f.text) });
  }
  const bodyFor = (title: string): string[] => bodies.get(normalizeTitle(title))?.paras ?? [];

  const titleName = titleCol || header[0];
  const columns: NotionColumn[] = [];
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
  const orphans = [...bodies.keys()].filter(
    (t) => !records.some((r) => normalizeTitle(r.title) === t)
  );
  return { records, bodies, columns, matched, orphans };
}

export function bodyForTitle(plan: NotionPlan, title: string): string[] {
  return plan.bodies.get(normalizeTitle(title))?.paras ?? [];
}

async function findPageId(
  t: StdbTransport,
  parentId: number | null,
  title: string
): Promise<number> {
  const pk = parentId ?? 0;
  const rows = await t.sql<{ id: number }>(
    "SELECT id FROM page WHERE parent_pk = ? AND title = ?",
    [pk, title]
  );
  if (rows.length === 0) throw new Error(`created page missing: ${title}`);
  return Math.max(...rows.map((r) => Number(r.id)));
}

/** SATS-JSON Option<u64>: null passes for none, Some must be `[0, v]`. */
const optId = (id: number | null): null | [number, number] =>
  id === null ? null : [0, id];

async function writeBody(
  t: StdbTransport,
  pageId: number,
  title: string,
  paras: string[]
): Promise<void> {
  if (paras.length === 0) return;
  const nodes = await t.sql<{ id: number; parent_id: number | null; component_type: string }>(
    "SELECT id, parent_id, component_type FROM component_node WHERE surface_id = ?",
    [pageId]
  );
  const isNone = (v: unknown): boolean =>
    v == null || (Array.isArray(v) && v[0] === 1);
  const root = nodes.find((x) => isNone(x.parent_id));
  if (!root) throw new Error(`no root node for page ${title}`);
  const rootId = Number(root.id);
  for (const x of nodes) {
    if (Number(x.id) !== rootId && String(x.component_type) === "RichText") {
      await t.call("delete_component", [Number(x.id)]);
    }
  }
  let after: number | null = null;
  for (const text of paras) {
    await t.call("insert_component", [rootId, "RichText", "{}", optId(after)]);
    const kids = await t.sql<{ id: number }>(
      "SELECT id FROM component_node WHERE surface_id = ?",
      [pageId]
    );
    const newId = Math.max(...kids.map((k) => Number(k.id)));
    const doc = plainTextToYDoc(text);
    const bytes = Array.from(Y.encodeStateAsUpdate(doc));
    await t.call("save_component_yjs_state", [newId, bytes]);
    after = newId;
  }
}

export interface RunProgress {
  rowsDone: number;
  rowsTotal: number;
  stage: string;
}

/** Execute a plan. Refuses when the database page already exists (live rows). */
export async function runNotionImport(
  t: StdbTransport,
  plan: NotionPlan,
  opts: { dbName: string; containerName?: string; onProgress?: (p: RunProgress) => void }
): Promise<{ dbId: number; rows: number; docs: number }> {
  const { dbName, containerName, onProgress } = opts;
  const progress = (rowsDone: number, rowsTotal: number, stage: string) =>
    onProgress?.({ rowsDone, rowsTotal, stage });

  let parentId: number | null = null;
  if (containerName) {
    await t.call("create_page", [null, { doc: [] }, containerName]);
    parentId = await findPageId(t, null, containerName);
  }
  const live = (
    await t.sql<{ id: number; deleted_at: unknown }>(
      "SELECT id, deleted_at FROM page WHERE title = ?",
      [dbName]
    )
  ).filter(
    (r) => r.deleted_at == null || (Array.isArray(r.deleted_at) && r.deleted_at[0] === 1)
  );
  if (live.length > 0) {
    throw new Error(`Database page "${dbName}" already exists. Delete it first for a clean import.`);
  }
  await t.call("create_page", [optId(parentId), { database: [] }, dbName]);
  const dbId = await findPageId(t, parentId, dbName);
  progress(0, plan.records.length, "database created");

  await t.call("create_database_schema", [dbId, dbName]);
  const schemas = await t.sql<{ id: number }>(
    "SELECT id FROM database_schema WHERE page_id = ?",
    [dbId]
  );
  const schemaId = Math.max(...schemas.map((r) => Number(r.id)));

  for (const col of plan.columns) {
    const type =
      col.kind === "select" ? { select: [] } : col.kind === "number" ? { number: [] } : { text: [] };
    const config = col.kind === "select" ? JSON.stringify({ options: col.options ?? [] }) : "{}";
    await t.call("add_property", [schemaId, col.name, type, config]);
  }
  const propDefs = await t.sql<{ id: number; name: string }>(
    "SELECT id, name FROM property_definition WHERE schema_id = ?",
    [schemaId]
  );
  const propId = (name: string): number => {
    const found = propDefs.find((p) => String(p.name) === name);
    if (!found) throw new Error(`property ${name} missing after add`);
    return Number(found.id);
  };

  let n = 0;
  for (const rec of plan.records) {
    await t.call("create_page", [optId(dbId), { database: [] }, rec.title]);
    const rowId = await findPageId(t, dbId, rec.title);
    for (const col of plan.columns) {
      const raw = rec.values.get(col.name) ?? "";
      if (raw === "") continue;
      if (col.kind === "select") {
        await t.call("set_property_value", [rowId, propId(col.name), { select: raw }]);
      } else if (col.kind === "number") {
        const num = Number.parseFloat(raw.replace(",", "."));
        if (!Number.isFinite(num)) continue;
        await t.call("set_property_value", [rowId, propId(col.name), { number: num }]);
      } else {
        await t.call("set_property_value", [rowId, propId(col.name), { text: raw }]);
      }
    }
    await writeBody(t, rowId, rec.title, bodyForTitle(plan, rec.title));
    n++;
    if (n % 20 === 0 || n === plan.records.length) progress(n, plan.records.length, "rows");
  }

  // Orphan MD files become plain Doc pages (original display titles kept).
  let m = 0;
  for (const normTitle of plan.orphans) {
    const entry = plan.bodies.get(normTitle);
    if (!entry) continue;
    await t.call("create_page", [optId(parentId), { doc: [] }, entry.display]);
    const pageId = await findPageId(t, parentId, entry.display);
    await writeBody(t, pageId, entry.display, entry.paras);
    m++;
    progress(n, plan.records.length, "orphan docs");
  }
  return { dbId, rows: n, docs: m };
}
