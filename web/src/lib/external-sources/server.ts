import { readBoundedBody, BodyTooLargeError } from "../read-bounded-body";
import { createHash } from "node:crypto";
import { HttpStdbTransport } from "../api-endpoint/http-transport";
import { decodePropertyValue, unwrapScalar } from "../api-endpoint/codec";
import type { StdbTransport } from "../api-endpoint/types";
import { atPath, describeRecord, mappedValues, latestDate } from "./mapping";
import { parseSourceConfig, parseSourceConfigs, parseRecordLink, refreshInterval, type SourceConfig, type SourceStatus, type ExternalRecord, type SourceEnrichment } from "./types";

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
interface Schema { page_id: string | number; config: unknown; deleted_at?: unknown }
interface Row { id: string | number; parent_id: unknown; deleted_at: unknown }
interface Cell { page_id: string | number; value: unknown }
export function configFromSchema(schema: Schema) {
  const raw = unwrapScalar(schema.config);
  return parseSourceConfig(typeof raw === "string" ? raw : null);
}
export interface LoadedSource {
  config: SourceConfig;
  secret: string;
  settings?: SourceConfig;
  primarySourceKey?: string;
  requestCache?: Map<string, Promise<unknown>>;
}
export function configsFromSchema(schema: Schema): SourceConfig[] {
  const raw = unwrapScalar(schema.config);
  return parseSourceConfigs(typeof raw === "string" ? raw : null);
}
function listSignature(rules: SourceEnrichment[] = []): string {
  return JSON.stringify(rules.map(rule => [rule.path, rule.resultsPath, rule.recordMatchPath, rule.matchPath, rule.targetField]));
}
export async function loadSource(transport: StdbTransport, databaseId: string, sourceId?: string): Promise<LoadedSource> {
  const [schema] = await transport.sql<Schema>("SELECT database_schema.page_id, database_schema.config, page.deleted_at FROM database_schema JOIN page ON database_schema.page_id = page.id WHERE database_schema.page_id = ?", [BigInt(databaseId)]);
  const configs = schema && unwrapScalar(schema.deleted_at) == null ? configsFromSchema(schema) : [];
  const config = sourceId == null || sourceId === "" ? configs[0] : configs.find(c => c.sourceId === sourceId);
  if (!config?.enabled) throw new Error("Enable an external data source in this database first");
  let secret = "";
  let settings: SourceConfig | undefined;
  if (config.sourceId) {
    const [setting] = await transport.sql<{ value_json: string }>("SELECT value_json FROM workspace_setting WHERE key = ?", ["external-source." + config.sourceId]);
    const shared: SourceConfig | undefined = setting && JSON.parse(setting.value_json);
    settings = shared;
    const keys = ["name", "baseUrl", "searchPath", "queryParam", "resultsPath", "detailPath", "detailResultPath",
      "idPath", "labelPath", "subtitlePath", "imagePath", "authHeader", "authPrefix"] as const;
    if (!shared || listSignature(shared.enrichments) !== listSignature(config.enrichments) || keys.some(key => shared[key] !== config[key]) || (shared.recordMode || "detail") !== (config.recordMode || "detail") || (shared.imageUrlTemplate || "") !== (config.imageUrlTemplate || "")) throw new Error("Workspace source changed; save this database connection again");
    if (config.authHeader) {
      const [row] = await transport.sql<{ secret: string; scope: string }>("SELECT secret, scope FROM shared_external_source_secret WHERE source_id = ?", [config.sourceId]);
      if (!row?.secret || row.scope !== JSON.stringify([config.baseUrl, config.authHeader, config.authPrefix])) {
        throw new Error("Re-enter the credential in workspace Data sources");
      }
      secret = row.secret;
    }
  } else if (config.authHeader) {
    const [row] = await transport.sql<{ secret: string; scope: string }>("SELECT secret, scope FROM external_source_secret WHERE database_id = ?", [BigInt(databaseId)]);
    secret = row?.secret || "";
    if (!secret || unwrapScalar(row.scope) !== JSON.stringify([config.baseUrl, config.authHeader, config.authPrefix])) throw new Error("This source needs a scoped credential; run pending migrations or re-enter it in connection settings");
  }
  return { config, secret, settings, primarySourceKey: configs[0]?.sourceId || "" };
}

export function sourceUrl(config: SourceConfig, path: string): URL {
  const base = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid source base URL");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid source API path");
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}${path}`);
  if (url.origin !== base.origin) throw new Error("Source API path changed origin");
  return url;
}
async function requestJson(source: LoadedSource, url: URL): Promise<unknown> {
  if (!source.requestCache) return requestJsonUncached(source, url);
  const key = url.toString();
  let request = source.requestCache.get(key);
  if (!request) {
    if (source.requestCache.size >= 500) source.requestCache.delete(source.requestCache.keys().next().value!);
    request = requestJsonUncached(source, url);
    source.requestCache.set(key, request);
  }
  return request;
}
async function requestJsonUncached(source: LoadedSource, url: URL): Promise<unknown> {
  const headers = new Headers({ Accept: "application/json" });
  try {
    if (source.config.authHeader) headers.set(source.config.authHeader, source.config.authPrefix + source.secret);
  } catch { throw new Error("Invalid source authentication header"); }
  let response: Response;
  const signal = AbortSignal.timeout(15_000);
  try {
    response = await fetch(url, { headers, cache: "no-store", redirect: "error", signal });
  } catch { throw new Error("Cannot reach the external source (connection, redirect or timeout)"); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`External source returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("External source returned an empty response");
  let body: string;
  try {
    body = new TextDecoder().decode(await readBoundedBody(response.body, 2_000_000, signal));
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new Error("External source response exceeds 2 MB");
    throw new Error("Cannot read the external source (connection or timeout)");
  }
  try { return JSON.parse(body); } catch { throw new Error("External source did not return JSON"); }
}
interface CollectionSnapshot { records: ExternalRecord[]; raw: Map<string, unknown> }
interface CollectionEntry { expires: number; promise: Promise<CollectionSnapshot> }
const memory = globalThis as typeof globalThis & { __externalCollections?: Map<string, CollectionEntry> };
const collections = memory.__externalCollections ??= new Map();
function collectionKey(source: LoadedSource): string {
  // Fingerprint credentials privately; cache keys and entries are never persisted.
  return createHash("sha256").update(JSON.stringify([sourceEnvironment().db, sourceEnvironment().stdb,
    source.config.sourceId, source.config.recordMode, source.config.baseUrl, source.config.searchPath, source.config.resultsPath,
    source.config.idPath, source.config.labelPath, source.config.subtitlePath, source.config.imagePath, source.config.imageUrlTemplate, listSignature(source.config.enrichments), source.config.authHeader, source.config.authPrefix, source.secret])).digest("hex");
}
interface EnrichmentEntry { expires: number; promise: Promise<Map<string, unknown>> }
const enrichmentMemory = globalThis as typeof globalThis & { __externalEnrichmentLists?: Map<string, EnrichmentEntry> };
const enrichmentLists = enrichmentMemory.__externalEnrichmentLists ??= new Map();
function enrichmentKey(source: LoadedSource, rule: SourceEnrichment) { return collectionKey(source) + ":" + listSignature([rule]); }
function joinKey(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : null;
}
async function enrichmentIndex(source: LoadedSource, rule: SourceEnrichment): Promise<Map<string, unknown>> {
  const key = enrichmentKey(source, rule), cached = enrichmentLists.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  if (enrichmentLists.size >= 128 && !enrichmentLists.has(key)) enrichmentLists.delete(enrichmentLists.keys().next().value!);
  const entry: EnrichmentEntry = { expires: Date.now() + Math.max(60, refreshInterval(source.settings || source.config)) * 1000,
    promise: (async () => {
      const body = await requestJson(source, sourceUrl(source.config, rule.path));
      const rows = atPath(body, rule.resultsPath);
      if (!Array.isArray(rows) || rows.length > 20_000) throw new Error("Additional list results path must point to a bounded JSON array");
      const index = new Map<string, unknown>();
      for (const row of rows) {
        const id = joinKey(atPath(row, rule.matchPath));
        if (id == null) throw new Error("Additional list record is missing a valid match field");
        if (index.has(id)) throw new Error("Additional list returned duplicate match values");
        index.set(id, row);
      }
      return index;
    })() };
  enrichmentLists.set(key, entry);
  try { const result = await entry.promise; return enrichmentLists.get(key) === entry ? result : enrichmentIndex(source, rule); }
  catch (error) {
    if (enrichmentLists.get(key) === entry) enrichmentLists.delete(key);
    throw new Error(`Additional list "${rule.targetField}": ${error instanceof Error ? error.message : "request failed"}`);
  }
}
export async function enrichRecords(source: LoadedSource, records: unknown[]): Promise<unknown[]> {
  let result = records;
  for (const rule of source.config.enrichments || []) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(rule.targetField) || ["__proto__", "prototype", "constructor"].includes(rule.targetField)) throw new Error("Invalid additional list target field");
    const index = await enrichmentIndex(source, rule);
    result = result.map(record => {
      if (record == null || typeof record !== "object" || Array.isArray(record)) throw new Error("Source record must be an object for additional lists");
      if (Object.prototype.hasOwnProperty.call(record, rule.targetField)) throw new Error("Additional list target field conflicts with an existing record field");
      const key = joinKey(atPath(record, rule.recordMatchPath));
      const extra = key == null ? undefined : index.get(key);
      return extra === undefined ? record : { ...record, [rule.targetField]: extra };
    });
  }
  return result;
}
export function invalidateSourceCache(source: LoadedSource) {
  collections.delete(collectionKey(source));
  for (const rule of source.config.enrichments || []) enrichmentLists.delete(enrichmentKey(source, rule));
  source.requestCache?.clear();
}
export async function sourceCollection(source: LoadedSource): Promise<CollectionSnapshot> {
  const key = collectionKey(source);
  const cached = collections.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  // Start both primary and additional lists together for each new snapshot.
  for (const rule of source.config.enrichments || []) enrichmentLists.delete(enrichmentKey(source, rule));
  if (collections.size >= 32 && !collections.has(key)) collections.delete(collections.keys().next().value!);
  const entry: CollectionEntry = { expires: Date.now() + Math.max(60, refreshInterval(source.settings || source.config)) * 1000,
    promise: (async () => {
      const body = await requestJson(source, sourceUrl(source.config, source.config.searchPath));
      const baseRows = atPath(body, source.config.resultsPath);
      if (!Array.isArray(baseRows) || baseRows.length > 20_000) throw new Error("Collection results path must point to a bounded JSON array; check API access and visibility");
      const rows = await enrichRecords(source, baseRows);
      const records = rows.map(row => describeRecord(row, source.config));
      const raw = new Map<string, unknown>();
      records.forEach((record, i) => { if (raw.has(record.id)) throw new Error("Collection returned duplicate record IDs"); raw.set(record.id, rows[i]); });
      return { records, raw };
    })() };
  collections.set(key, entry);
  try { const result = await entry.promise; return collections.get(key) === entry ? result : sourceCollection(source); }
  catch (error) { if (collections.get(key) === entry) collections.delete(key); throw error; }
}
export async function searchSource(source: LoadedSource, query: string) {
  if (source.config.recordMode === "collection") {
    const snapshot = await sourceCollection(source);
    const term = query.slice(0, 200).normalize("NFKC").toLowerCase().trim();
    return snapshot.records.filter(record => record.label.normalize("NFKC").toLowerCase().includes(term)).slice(0, 50);
  }
  const url = sourceUrl(source.config, source.config.searchPath);
  url.searchParams.set(source.config.queryParam, query.slice(0, 200));
  const data = await requestJson(source, url);
  const records = atPath(data, source.config.resultsPath);
  if (!Array.isArray(records)) throw new Error("Search results path must point to a JSON array");
  return (await enrichRecords(source, records.slice(0, 50))).map(raw => describeRecord(raw, source.config));
}
export async function fetchRecord(source: LoadedSource, id: string) {
  // Dot-only path segments are normalized even when percent-encoded by URL.
  if (id === "." || id === "..") throw new Error("Invalid external record id");
  const encoded = encodeURIComponent(id);
  const path = source.config.detailPath.replaceAll("{id}", encoded);
  const result = source.config.recordMode === "collection"
    ? (await sourceCollection(source)).raw.get(id)
    : (await enrichRecords(source, [atPath(await requestJson(source, sourceUrl(source.config, path)), source.config.detailResultPath)]))[0];
  if (result == null) throw new Error("Record is not present in the current source collection; saved values were kept");
  const record = describeRecord(result, source.config);
  if (record.id !== id) throw new Error("External source returned a different record id");
  const overrides = new Map<string, unknown>();
  const relatedCache = new Map<string, Promise<string | null>>();
  for (const mapping of source.config.mappings) {
    const related = mapping.related;
    if (!related || (related.whenPath && String(atPath(result, related.whenPath)) !== related.whenEquals)) continue;
    const key = JSON.stringify(related);
    let request = relatedCache.get(key);
    if (!request) { request = fetchRelatedDate(source, id, related); relatedCache.set(key, request); }
    overrides.set(mapping.targetPropertyId, latestDate([atPath(result, mapping.sourcePath), await request]));
  }
  return { record, values: mappedValues(result, source.config, overrides) };
}
/** Fully read a bounded paginated collection; never publish a partial maximum. */
export async function fetchRelatedDate(source: LoadedSource, id: string, related: import("./types").RelatedDate): Promise<string | null> {
  if (id === "." || id === "..") throw new Error("Invalid external record id");
  const size = related.pageSize;
  if (!Number.isInteger(size) || size < 1 || size > 500) throw new Error("Invalid related page size");
  const dates: unknown[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const url = sourceUrl(source.config, related.path.replaceAll("{id}", encodeURIComponent(id)));
    if (related.offsetParam) url.searchParams.set(related.offsetParam, String(offset));
    if (related.limitParam) url.searchParams.set(related.limitParam, String(size));
    const body = await requestJson(source, url);
    const items = atPath(body, related.resultsPath);
    if (!Array.isArray(items) || items.length > 10_000 || dates.length + items.length > 10_000) {
      throw new Error("Invalid or oversized related record collection");
    }
    dates.push(...items.map(item => atPath(item, related.valuePath)));
    offset += items.length;
    const total = related.totalPath ? atPath(body, related.totalPath) : null;
    if (total != null && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) throw new Error("Invalid related collection total");
    if (total != null && offset >= total) return latestDate(dates);
    if (total == null && (!related.limitParam || items.length < size)) return latestDate(dates);
    if (!items.length || !related.offsetParam || !related.limitParam) throw new Error("Related collection is incomplete");
  }
  throw new Error("Related collection exceeds pagination limit; existing values were kept");
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
  if ((link.sourceId ?? source.primarySourceKey ?? source.config.sourceId ?? "") !== (source.config.sourceId || "")) {
    throw new Error("This row is linked to a different source");
  }
  return applyRecord(transport, source, rowId, link.id);
}

export async function loadRowSource(transport: StdbTransport, databaseId: string, rowId: string): Promise<LoadedSource> {
  const [schema] = await transport.sql<Schema>("SELECT database_schema.page_id, database_schema.config, page.deleted_at FROM database_schema JOIN page ON database_schema.page_id = page.id WHERE database_schema.page_id = ?", [BigInt(databaseId)]);
  const primary = schema && configFromSchema(schema);
  if (!primary) throw new Error("No source connected");
  const [cell] = await transport.sql<Cell>("SELECT page_id, value FROM page_property_value WHERE page_id = ? AND property_definition_id = ?", [BigInt(rowId), BigInt(primary.linkPropertyId)]);
  const value = cell && decodePropertyValue(cell.value);
  const link = typeof value === "string" && parseRecordLink(value);
  if (!link) throw new Error("Select an external record first");
  return loadSource(transport, databaseId, link.sourceId);
}

interface PollState { revision: string; nextRun: number; lastRun: string | null; change?: string; applied: Map<string, string>; error: boolean; failures: number; waiting?: boolean; pendingLinks?: string }
const globals = globalThis as typeof globalThis & {
  __externalSourceWorker?: { started: boolean; running: boolean; states: Map<string, SourceStatus>; polls: Map<string, PollState> };
};
const worker = globals.__externalSourceWorker ??= { started: false, running: false, states: new Map(), polls: new Map() };
function bindingKey(databaseId: string, sourceId?: string) { return databaseId + ":" + (sourceId || ""); }
export function workerStatus(databaseId: string, sourceId?: string): SourceStatus {
  const state = worker.states.get(bindingKey(databaseId, sourceId)) || (!sourceId ? [...worker.states].find(([key]) => key.startsWith(databaseId + ":"))?.[1] : undefined);
  return state || {
    serviceConfigured: !!sourceEnvironment().token,
    automaticSync: !!sourceEnvironment().token && process.env.EXTERNAL_SOURCE_SYNC_ENABLED !== "false",
    lastRun: null, updated: 0, error: null,
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
    if (!link || (link.sourceId ?? source.primarySourceKey ?? source.config.sourceId ?? "") !== (source.config.sourceId || "")) continue;
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
export async function runSourceWorkerCycle(transport: StdbTransport, now = Date.now()) {
  const schemas = await transport.sql<Schema>("SELECT database_schema.page_id, database_schema.config, page.deleted_at FROM database_schema JOIN page ON database_schema.page_id = page.id");
  const groups = new Map<string, { databaseId: string; config: SourceConfig; primarySourceKey: string }[]>();
  const activeBindings = new Set<string>();
  for (const schema of schemas.filter(s => unwrapScalar(s.deleted_at) == null)) for (const config of configsFromSchema(schema)) {
    const databaseId = String(schema.page_id), key = config.sourceId || "legacy:" + databaseId;
    activeBindings.add(bindingKey(databaseId, config.sourceId));
    if (!config.enabled) {
      worker.states.set(bindingKey(databaseId, config.sourceId), { serviceConfigured: !!sourceEnvironment().token, automaticSync: false, lastRun: null, updated: 0, error: null, syncMode: config.syncMode });
      continue;
    }
    const primarySourceKey = configsFromSchema(schema)[0]?.sourceId || "";
    const list = groups.get(key) || []; list.push({ databaseId, config, primarySourceKey }); groups.set(key, list);
  }
  for (const key of worker.states.keys()) if (!activeBindings.has(key)) worker.states.delete(key);
  for (const key of worker.polls.keys()) if (!groups.has(key)) worker.polls.delete(key);
  for (const [key, bindings] of groups) {
    const previous = worker.polls.get(key);
    const state: PollState = previous || { revision: "", nextRun: 0, lastRun: null, applied: new Map(), error: false, failures: 0 };
    let interval = 21600, mode: string = "interval", shouldSync = true, changed: string | undefined;
    const requestCache = new Map<string, Promise<unknown>>();
    let checkedRevision = state.revision;
    try {
      const first = await loadSource(transport, bindings[0].databaseId, bindings[0].config.sourceId);
      const settings = first.settings || first.config;
      interval = Math.max(60, refreshInterval(settings));
      mode = settings.syncMode || "interval";
      const revision = settings.revision;
      checkedRevision = revision;
      const pendingConfig = bindings.some(binding => state.applied.get(bindingKey(binding.databaseId, binding.config.sourceId)) !== binding.config.revision);
      const due = state.nextRun <= now || state.revision !== revision;
      if (mode === "manual") {
        for (const binding of bindings) worker.states.set(bindingKey(binding.databaseId, binding.config.sourceId), { serviceConfigured: true, automaticSync: false, lastRun: state.lastRun, updated: 0, error: null, syncMode: mode });
        continue;
      }
      // Links carry their last successfully applied mapping revision. Unlike
      // an in-memory poll flag, this survives failed HTTP requests and restarts.
      const dirty: string[] = [];
      for (const binding of bindings) {
        const rows = await transport.sql<Row>("SELECT id, parent_id, deleted_at FROM page WHERE parent_pk = ?", [BigInt(binding.databaseId)]);
        const active = new Set(rows.filter(row => unwrapScalar(row.deleted_at) == null).map(row => String(row.id)));
        const cells = await transport.sql<Cell>("SELECT page_id, value FROM page_property_value WHERE property_definition_id = ?", [BigInt(binding.config.linkPropertyId)]);
        for (const cell of cells) {
          if (!active.has(String(cell.page_id))) continue;
          const value = decodePropertyValue(cell.value);
          const link = typeof value === "string" ? parseRecordLink(value) : null;
          if (link && (link.sourceId ?? binding.primarySourceKey) === (binding.config.sourceId || "") && link.syncedRevision !== binding.config.revision) {
            dirty.push(JSON.stringify([binding.databaseId, cell.page_id, value, binding.config.revision]));
          }
        }
      }
      const pendingLinks = JSON.stringify(dirty.sort());
      const pending = pendingConfig || dirty.length > 0;
      const previouslyPending = new Set<string>(JSON.parse(state.pendingLinks || "[]"));
      const newLinks = dirty.some(link => !previouslyPending.has(link));
      state.pendingLinks = pendingLinks;
      if (!due && ((!pendingConfig && !newLinks) || state.waiting)) continue;
      first.requestCache = requestCache;
      if (mode === "change") {
        const body = await requestJson(first, sourceUrl(first.config, settings.changePath || ""));
        const success = atPath(body, settings.changeSuccessPath || "");
        const version = atPath(body, settings.changeValuePath || "");
        state.waiting = String(success) !== settings.changeSuccessValue;
        if (state.waiting) shouldSync = false;
        else {
          if (version == null || !["number", "string"].includes(typeof version) || version === "") throw new Error("Source status has no completed revision");
          changed = JSON.stringify(version);
          shouldSync = pending || state.error || changed !== state.change;
        }
      }
      // A scheduled refresh replaces the collection once, shared by every table.
      if (shouldSync && ((changed != null && changed !== state.change) || (due && state.lastRun))) invalidateSourceCache(first);
      let failed = 0;
      for (const binding of bindings) {
        let updated = 0, error: string | null = null;
        if (shouldSync) {
          try {
            const source = await loadSource(transport, binding.databaseId, binding.config.sourceId);
            source.requestCache = requestCache;
            const result = await syncSourceDatabase(transport, binding.databaseId, source);
            updated = result.updated;
            if (result.failed) error = result.failed + " record(s) could not be refreshed; saved values were kept";
          } catch { error = "Cannot refresh this source; check credentials, API paths and connectivity"; }
          state.applied.set(bindingKey(binding.databaseId, binding.config.sourceId), binding.config.revision);
        }
        if (error) failed++;
        worker.states.set(bindingKey(binding.databaseId, binding.config.sourceId), { serviceConfigured: true, automaticSync: true, lastRun: new Date(now).toISOString(), updated, error, syncMode: mode, waitingForChange: !shouldSync });
      }
      state.error = failed > 0;
      state.failures = failed ? state.failures + 1 : 0;
      if (!failed && changed != null && shouldSync) state.change = changed;
      state.revision = revision;
    } catch {
      state.error = true; state.failures++; state.revision = checkedRevision;
      for (const binding of bindings) {
        state.applied.set(bindingKey(binding.databaseId, binding.config.sourceId), binding.config.revision);
        worker.states.set(bindingKey(binding.databaseId, binding.config.sourceId), { serviceConfigured: true, automaticSync: mode !== "manual", lastRun: new Date(now).toISOString(), updated: 0, error: "Cannot check source; verify configuration, credentials and connectivity", syncMode: mode });
      }
    }
    state.lastRun = new Date(now).toISOString();
    state.nextRun = now + (state.error ? Math.min(interval, 300 * 2 ** Math.min(6, state.failures - 1)) : interval) * 1000;
    worker.polls.set(key, state);
  }
}
export function startExternalSourceWorker() {
  if (worker.started || !sourceEnvironment().token || process.env.EXTERNAL_SOURCE_SYNC_ENABLED === "false") return;
  worker.started = true;
  const transport = serviceTransport();
  async function tick() {
    if (worker.running) return;
    worker.running = true;
    try { await runSourceWorkerCycle(transport); }
    catch { console.error("[external-source] Cannot read database configuration; will retry"); }
    finally { worker.running = false; setTimeout(tick, 60_000).unref(); }
  }
  setTimeout(tick, 5_000).unref();
}
