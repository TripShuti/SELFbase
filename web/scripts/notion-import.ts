/**
 * CLI wrapper around the shared Notion import core (`@/src/lib/notionImport`).
 *
 * Same behavior as the in-app importer, but runs from a shell with a
 * publisher-capable token (no empty-DB restriction, no browser needed).
 *
 * Usage:
 *   pnpm --filter @selfbase/web import:notion -- \
 *     --csv "/path/Table.csv" --md "/path/export" --db "Table" \
 *     [--title-col "Назва"] [--select "Status"] [--number "Hours"] \
 *     [--skip "Date"] [--container "X"] [--dry-run] [--self-test]
 *
 * Env: SELFBASE_URL (default http://127.0.0.1:3000),
 *      SELFBASE_DB (default selfbase), SELFBASE_TOKEN (else local CLI token).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { HttpStdbTransport } from "../src/lib/api-endpoint/index.js";
import {
  buildNotionPlan,
  runNotionImport,
} from "../src/lib/notionImport.js";

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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

const splitList = (v: string | boolean | undefined): string[] =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

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

async function main(): Promise<void> {
  const args = parseArgs();
  const csvPath = args.csv as string;
  const mdDir = (args.md as string) ?? "";
  const dbName = (args.db as string) ?? "Notion import";
  if (!csvPath && !mdDir && args["self-test"] !== true) {
    throw new Error("Required: --csv <path> and/or --md <dir>");
  }

  const base = (process.env.SELFBASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const db = process.env.SELFBASE_DB ?? "selfbase";
  const transport = new HttpStdbTransport({
    baseUrl: base,
    dbName: db,
    token: readToken(),
  });

  if (args["self-test"] === true) {
    // Cheap connectivity + write check (create + delete a scratch page).
    await transport.call("create_page", [null, { doc: [] }, "IMPORT-SELFTEST"]);
    const rows = await transport.sql<{ id: number }>(
      "SELECT id FROM page WHERE title = ?",
      ["IMPORT-SELFTEST"]
    );
    const pid = Math.max(...rows.map((r) => Number(r.id)));
    await transport.call("delete_page", [pid]);
    console.log("SELFTEST PASSED (connect + write + delete).");
    return;
  }

  const csvText = csvPath ? readFileSync(csvPath, "utf8") : undefined;
  const mdFiles = mdDir
    ? readdirSync(mdDir)
        .filter((x) => x.endsWith(".md"))
        .map((name) => ({ name, text: readFileSync(join(mdDir, name), "utf8") }))
    : [];

  const plan = buildNotionPlan({
    csvText,
    mdFiles,
    dbName,
    titleCol: (args["title-col"] as string) || undefined,
    selectCols: splitList(args.select),
    numberCols: splitList(args.number),
    skipCols: splitList(args.skip),
  });

  console.log(
    `CSV records: ${plan.records.length}, MD files: ${mdFiles.length}, ` +
      `rows with body: ${plan.matched}, orphan MD: ${plan.orphans.length}`
  );
  console.log(`Columns: ${plan.columns.map((c) => `${c.name}(${c.kind})`).join(", ") || "(none)"}`);
  if (args["dry-run"] === true) {
    console.log("DRY RUN — no writes.");
    return;
  }

  const res = await runNotionImport(transport, plan, {
    dbName,
    containerName: (args.container as string) || undefined,
    onProgress: (p) => {
      if (p.rowsDone % 20 === 0 || p.rowsDone === p.rowsTotal) {
        console.log(`  …${p.rowsDone}/${p.rowsTotal} rows (${p.stage})`);
      }
    },
  });
  console.log(`DONE: database "${dbName}" (${res.dbId}) with ${res.rows} rows + ${res.docs} standalone docs.`);
}

main().catch((err) => {
  console.error("IMPORT FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
