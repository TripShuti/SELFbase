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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpStdbTransport } from "../src/lib/api-endpoint/index.js";
import {
  chunkSelfbaseSnapshotV2,
  type SelfbaseSnapshotV2,
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
  const base = (process.env.SELFBASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const token = readToken();
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as SelfbaseSnapshotV2;

  // Create the empty DB if missing (raw PUT; CLI can't create on 2.0.3).
  try {
    await new HttpStdbTransport({ baseUrl: base, dbName: targetDb, token }).sql(
      "SELECT key FROM migration_state LIMIT 1"
    );
    console.log(`database "${targetDb}" exists, importing into it (must be empty)`);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (!msg.includes("not found")) throw err;
    console.log(`creating database "${targetDb}"...`);
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const wasmPath = join(scriptDir, "..", "..", "server", "docker", "server.wasm");
    execFileSync(
      "curl",
      [
        "-s", "-m", "120", "-X", "PUT",
        "--data-binary", `@${wasmPath}`,
        `${base}/v1/database/${targetDb}`,
        "-H", "Content-Type: application/wasm",
        "-H", `Authorization: Bearer ${token}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log("created");
  }

  const t = new HttpStdbTransport({ baseUrl: base, dbName: targetDb, token });
  // Import requires an authenticated caller. On a fresh DB, registration is
  // open: register the publisher identity (first user becomes admin).
  try {
    await t.call("register", ["restore@localhost", "Restore", "restore-restore-restore-00"]);
    console.log("registered restore identity (first user → admin)");
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (!msg.includes("already initialized")) throw err;
    console.log("database already initialized, continuing");
  }
  const { header, chunks, manifest } = chunkSelfbaseSnapshotV2(snap);
  console.log(`header ok, ${chunks.length} chunks`);
  await t.call("import_v_2_begin", [JSON.stringify(header)]);
  let done = 0;
  for (const chunk of chunks) {
    await t.call("import_v_2_chunk", [chunk.seq, chunk.tableName, chunk.rowsJson]);
    done++;
    if (done % 10 === 0 || done === chunks.length) console.log(`  …${done}/${chunks.length}`);
  }
  await t.call("import_v_2_commit", [JSON.stringify(manifest)]);
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
