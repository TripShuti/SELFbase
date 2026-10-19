/**
 * Restore a selfbase-snapshot-v2 JSON file into an EMPTY database
 * (chunked import_v_2_begin/chunk/commit, same path as Settings → Import).
 *
 * Usage:
 *   pnpm --filter @selfbase/web exec tsx scripts/restore-snapshot.ts /path/snap.json <targetDb>
 *
 * Env: SELFBASE_URL (default http://127.0.0.1:3000), SELFBASE_TOKEN
 * (else local Spacetime CLI token). Creates the target DB if missing
 * (needs the module wasm at server/docker/server.wasm for creation).
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpStdbTransport } from "../src/lib/api-endpoint/index.js";
import {
  parseSelfbaseSnapshotJson,
  restoreSelfbaseSnapshotV2,
} from "@selfbase/snapshot-core";

function readToken(): string {
  if (process.env.SELFBASE_TOKEN?.trim()) return process.env.SELFBASE_TOKEN.trim();
  const toml = readFileSync(join(homedir(), ".config", "spacetime", "cli.toml"), "utf8");
  const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error("no token");
  return m[1];
}

async function main(): Promise<void> {
  const [snapPath, targetDb] = process.argv.slice(2);
  if (!snapPath || !targetDb) throw new Error("usage: restore-snapshot.ts <snap.json> <targetDb>");
  const snap = parseSelfbaseSnapshotJson(readFileSync(snapPath, "utf8")).snapshot;
  const base = (process.env.SELFBASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const token = readToken();

  // Create the empty DB if missing (raw PUT; CLI can't create on 2.0.3).
  try {
    await new HttpStdbTransport({ baseUrl: base, dbName: targetDb, token, timeoutMs: 60_000 }).sql(
      "SELECT key FROM migration_state LIMIT 1"
    );
    console.log(`database "${targetDb}" exists, importing into it (must be empty)`);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (!msg.includes("not found")) throw err;
    console.log(`creating database "${targetDb}"...`);
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const wasmPath = join(scriptDir, "..", "..", "server", "docker", "server.wasm");
    const response = await fetch(`${base}/v1/database/${encodeURIComponent(targetDb)}`, {
      method: "PUT",
      body: readFileSync(wasmPath),
      headers: { "Content-Type": "application/wasm", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`Database creation failed (HTTP ${response.status})`);
    console.log("created");
  }

  const t = new HttpStdbTransport({ baseUrl: base, dbName: targetDb, token, timeoutMs: 60_000 });
  // Import requires an authenticated caller. On a fresh DB, registration is
  // open: register the publisher identity (first user becomes admin).
  try {
    await t.call("register", ["restore@localhost", "Restore", randomBytes(32).toString("hex")]);
    console.log("registered restore identity (first user → admin)");
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (!msg.includes("already initialized")) throw err;
    console.log("database already initialized, continuing");
  }
  console.log("snapshot preflight ok");
  await restoreSelfbaseSnapshotV2(snap, {
    importV2Begin: ({ headerJson }) => t.call("import_v_2_begin", [headerJson]),
    importV2Chunk: ({ seq, tableName, rowsJson }) => t.call("import_v_2_chunk", [seq, tableName, rowsJson]),
    importV2Commit: ({ manifestJson }) => t.call("import_v_2_commit", [manifestJson]),
  }, { onProgress: (done, total) => {
    if (done % 10 === 0 || done === total) console.log(`  …${done}/${total}`);
  } });
  console.log("COMMIT OK — verifying counts...");

  const pages = await t.sql<{ c: number }>("SELECT COUNT(*) AS c FROM page");
  const comments = await t.sql<{ c: number }>("SELECT COUNT(*) AS c FROM block_comment");
  const values = await t.sql<{ c: number }>("SELECT COUNT(*) AS c FROM page_property_value");
  console.log("restored:", JSON.stringify({ pages, comments, values }));
  const exp = snap.counts as Record<string, number>;
  const ok =
    Number((pages[0] as unknown as { c: number }).c) === exp.page &&
    Number((comments[0] as unknown as { c: number }).c) === exp.block_comment &&
    Number((values[0] as unknown as { c: number }).c) === exp.page_property_value;
  console.log(ok ? "COUNTS MATCH — restore verified" : "COUNT MISMATCH — investigate");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("RESTORE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
