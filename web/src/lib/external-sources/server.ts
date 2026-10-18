import { HttpStdbTransport } from "../api-endpoint/http-transport";
import { decodePropertyValue, unwrapScalar } from "../api-endpoint/codec";
import type { StdbTransport } from "../api-endpoint/types";
import { atPath, describeRecord, mappedValues } from "./mapping";
import { parseSourceConfig, parseRecordLink, type SourceConfig, type SourceStatus } from "./types";

export function sourceEnvironment() {
  return {
    db: process.env.SELFBASE_STDB_DB_NAME?.trim() || process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME || "selfbase",
    stdb: process.env.SELFBASE_STDB_URL?.trim() || process.env.SPACETIMEDB_INTERNAL_URL?.trim() || "http://spacetimedb:3000",
    token: process.env.SELFBASE_STDB_TOKEN?.trim(),
  };
}
export function httpPageId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) throw new Error("Page id is outside the supported HTTP range");
  return id;
}

export function callerTransport(token: string): HttpStdbTransport {
  const env = sourceEnvironment();
  return new HttpStdbTransport({ baseUrl: env.stdb, dbName: env.db, token, timeoutMs: 15_000 });
}
export function serviceTransport(): HttpStdbTransport {
  const env = sourceEnvironment();
  if (!env.token) throw new Error("A database-owner service token is required on the SELFbase server");
  return callerTransport(env.token);
}
interface Schema { page_id: string | number; config: unknown }
interface Row { id: string | number; parent_id: unknown; deleted_at: unknown }
interface Cell { page_id: string | number; value: unknown }
export function configFromSchema(schema: Schema) {
  const raw = unwrapScalar(schema.config);
  return parseSourceConfig(typeof raw === "string" ? raw : null);
}
export async function loadSource(transport: StdbTransport, databaseId: string) {
  const [schema] = await transport.sql<Schema>("SELECT page_id, config FROM database_schema WHERE page_id = ?", [BigInt(databaseId)]);
  const config = schema && configFromSchema(schema);
  if (!config?.enabled) throw new Error("Enable an external data source in this database first");
  let secret = "";
  if (config.sourceId) {
    const [setting] = await transport.sql<{ value_json: string }>("SELECT value_json FROM workspace_setting WHERE key = ?", ["external-source." + config.sourceId]);
    const shared: SourceConfig | undefined = setting && JSON.parse(setting.value_json);
    const keys = ["name", "baseUrl", "searchPath", "queryParam", "resultsPath", "detailPath", "detailResultPath",
      "idPath", "labelPath", "subtitlePath", "imagePath", "authHeader", "authPrefix"] as const;
    if (!shared || keys.some(key => shared[key] !== config[key])) throw new Error("Workspace source changed; save this database connection again");
    if (config.authHeader) {
      const [row] = await transport.sql<{ secret: string; scope: string }>("SELECT secret, scope FROM shared_external_source_secret WHERE source_id = ?", [config.sourceId]);
      if (!row?.secret || row.scope !== JSON.stringify([config.baseUrl, config.authHeader, config.authPrefix])) {
        throw new Error("Re-enter the credential in workspace Data sources");
      }
      secret = row.secret;
    }
  } else if (config.authHeader) {
    const [row] = await transport.sql<{ secret: string }>("SELECT secret FROM external_source_secret WHERE database_id = ?", [BigInt(databaseId)]);
    secret = row?.secret || "";
    if (!secret) throw new Error("This source needs a credential; re-enter it in connection settings");
  }
  return { config, secret };
}
export type LoadedSource = Awaited<ReturnType<typeof loadSource>>;

export function sourceUrl(config: SourceConfig, path: string): URL {
  const base = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid source base URL");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid source API path");
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}${path}`);
  if (url.origin !== base.origin) throw new Error("Source API path changed origin");
  return url;
}
async function requestJson(source: LoadedSource, url: URL): Promise<unknown> {
  const headers = new Headers({ Accept: "application/json" });
  try {
    if (source.config.authHeader) headers.set(source.config.authHeader, source.config.authPrefix + source.secret);
  } catch { throw new Error("Invalid source authentication header"); }
  let response: Response;
  try {
    response = await fetch(url, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("Cannot reach the external source (connection, redirect or timeout)"); }
  if (!response.ok) throw new Error(`External source returned HTTP ${response.status}`);
  // Stream with a hard bound: a malformed source must not exhaust server memory.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("External source returned an empty response");
  const decoder = new TextDecoder();
  let bytes = 0, body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 2_000_000) { await reader.cancel(); throw new Error("External source response exceeds 2 MB"); }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try { return JSON.parse(body); } catch { throw new Error("External source did not return JSON"); }
}
export async function searchSource(source: LoadedSource, query: string) {
  const url = sourceUrl(source.config, source.config.searchPath);
  url.searchParams.set(source.config.queryParam, query.slice(0, 200));
  const data = await requestJson(source, url);
  const records = atPath(data, source.config.resultsPath);
  if (!Array.isArray(records)) throw new Error("Search results path must point to a JSON array");
  return records.slice(0, 50).map(raw => describeRecord(raw, source.config));
}
export async function fetchRecord(source: LoadedSource, id: string) {
  // Dot-only path segments are normalized even when percent-encoded by URL.
  if (id === "." || id === "..") throw new Error("Invalid external record id");
  const encoded = encodeURIComponent(id);
  const path = source.config.detailPath.replaceAll("{id}", encoded);
  const result = atPath(await requestJson(source, sourceUrl(source.config, path)), source.config.detailResultPath);
  const record = describeRecord(result, source.config);
  if (record.id !== id) throw new Error("External source returned a different record id");
  return { record, values: mappedValues(result, source.config) };
}
export async function applyRecord(transport: StdbTransport, source: LoadedSource, rowId: string, id: string) {
  const result = await fetchRecord(source, id);
  await transport.call("apply_external_record", [httpPageId(rowId), JSON.stringify(source.config), id, result.record.label, JSON.stringify(result.values)]);
  return result.record;
}
export async function syncExternalRow(transport: StdbTransport, source: LoadedSource, databaseId: string, rowId: string) {
  const [row] = await transport.sql<Row>("SELECT id, parent_id, deleted_at FROM page WHERE id = ?", [BigInt(rowId)]);
  if (!row || unwrapScalar(row.deleted_at) != null || String(unwrapScalar(row.parent_id)) !== databaseId) throw new Error("Row not found in this database");
  const cells = await transport.sql<Cell>("SELECT page_id, value FROM page_property_value WHERE page_id = ? AND property_definition_id = ?", [BigInt(rowId), BigInt(source.config.linkPropertyId)]);
  const raw = cells[0] && decodePropertyValue(cells[0].value);
  const link = typeof raw === "string" ? parseRecordLink(raw) : null;
  if (!link) throw new Error("Select an external record first");
  return applyRecord(transport, source, rowId, link.id);
}

const globals = globalThis as typeof globalThis & {
  __externalSourceWorker?: { started: boolean; running: boolean; states: Map<string, SourceStatus & { revision: string; nextRun: number }> };
};
const worker = globals.__externalSourceWorker ??= { started: false, running: false, states: new Map() };
export function workerStatus(databaseId: string): SourceStatus {
  const state = worker.states.get(databaseId);
  return {
    serviceConfigured: !!sourceEnvironment().token,
    automaticSync: !!sourceEnvironment().token && process.env.EXTERNAL_SOURCE_SYNC_ENABLED !== "false",
    lastRun: state?.lastRun ?? null, updated: state?.updated ?? 0, error: state?.error ?? null,
  };
}
export async function syncSourceDatabase(transport: StdbTransport, databaseId: string, source: LoadedSource) {
  const rows = await transport.sql<Row>("SELECT id, parent_id, deleted_at FROM page WHERE parent_pk = ?", [BigInt(databaseId)]);
  const cells = await transport.sql<Cell>("SELECT page_id, value FROM page_property_value WHERE property_definition_id = ?", [BigInt(source.config.linkPropertyId)]);
  const links = new Map(cells.map(c => [String(c.page_id), decodePropertyValue(c.value)]));
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof fetchRecord>>>>();
  let updated = 0, failed = 0;
  for (const row of rows) {
    if (unwrapScalar(row.deleted_at) != null) continue;
    const raw = links.get(String(row.id));
    const link = typeof raw === "string" ? parseRecordLink(raw) : null;
    if (!link) continue;
    try {
      let result = cache.get(link.id);
      if (!result) { result = fetchRecord(source, link.id); cache.set(link.id, result); }
      const data = await result;
      await transport.call("apply_external_record", [httpPageId(String(row.id)), JSON.stringify(source.config), link.id, data.record.label, JSON.stringify(data.values)]);
      updated++;
    } catch { failed++; }
  }
  return { updated, failed };
}
export function startExternalSourceWorker() {
  if (worker.started || !sourceEnvironment().token || process.env.EXTERNAL_SOURCE_SYNC_ENABLED === "false") return;
  worker.started = true;
  const transport = serviceTransport();
  async function tick() {
    if (worker.running) return;
    worker.running = true;
    try {
      const schemas = await transport.sql<Schema>("SELECT page_id, config FROM database_schema");
      for (const schema of schemas) {
        const config = configFromSchema(schema);
        if (!config?.enabled) continue;
        const id = String(schema.page_id);
        const state = worker.states.get(id);
        if (state?.revision === config.revision && state.nextRun > Date.now()) continue;
        let updated = 0, error: string | null = null;
        try {
          const source = await loadSource(transport, id);
          const result = await syncSourceDatabase(transport, id, source);
          updated = result.updated;
          if (result.failed) error = `${result.failed} record(s) could not be refreshed; check the source and field mappings`;
        } catch { error = "Cannot refresh this source; check credentials, API paths and connectivity"; }
        worker.states.set(id, { ...workerStatus(id), updated, error, revision: config.revision,
          lastRun: new Date().toISOString(), nextRun: Date.now() + Math.max(60, config.syncIntervalSeconds) * 1000 });
        if (error) console.error(`[external-source] Database ${id}: ${error}`);
      }
    } catch { console.error("[external-source] Cannot read database configuration; will retry"); }
    finally { worker.running = false; setTimeout(tick, 60_000).unref(); }
  }
  setTimeout(tick, 5_000).unref();
}
