import { SNAPSHOT_TABLES_V2, SNAPSHOT_TABLE_POLICY_V2 } from "./tablePolicy";
import type { SelfbaseSnapshotV2 } from "./v2";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never { throw new Error(`Invalid selfbase-snapshot-v2 file: ${message}`); }

/** Complete envelope preflight shared by browser, CLI and direct chunk callers. */
export function validateSelfbaseSnapshotV2(value: unknown): asserts value is SelfbaseSnapshotV2 {
  if (!object(value) || value.format !== SNAPSHOT_TABLE_POLICY_V2.format) invalid("unsupported format");
  if (!object(value.tables)) invalid("missing tables");
  if (!object(value.counts)) invalid("missing counts");
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) invalid("invalid exportedAt");
  if (!object(value.workspace) || typeof value.workspace.wsUri !== "string" || !value.workspace.wsUri.trim() ||
      typeof value.workspace.dbName !== "string" || !value.workspace.dbName.trim()) invalid("invalid workspace");
  if (value.moduleVersion !== undefined && typeof value.moduleVersion !== "string") invalid("invalid moduleVersion");
  if (!object(value.blobManifest) || !Array.isArray(value.blobManifest.storageKeys) ||
      !value.blobManifest.storageKeys.every(key => typeof key === "string" && key.length > 0)) invalid("invalid blobManifest");
  const allowed = new Set<string>(SNAPSHOT_TABLES_V2);
  for (const name of [...Object.keys(value.tables), ...Object.keys(value.counts)]) {
    if (!allowed.has(name)) invalid(`unknown table ${name}`);
  }
  for (const name of SNAPSHOT_TABLES_V2) {
    const rows = value.tables[name];
    if (!Object.hasOwn(value.tables, name) || !Array.isArray(rows)) invalid(`missing or invalid tables.${name}`);
    const count = value.counts[name];
    if (!Object.hasOwn(value.counts, name) || !Number.isSafeInteger(count) || (count as number) < 0 || count !== rows.length) invalid(`counts.${name} does not match table rows`);
    const keys = new Set<string>();
    const keyField = name === "user" ? "identity" : name === "component_yjs_state" ? "componentNodeId"
      : name === "page_content" || name === "page_yjs_state" ? "pageId" : "id";
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!object(row) || Object.hasOwn(row, "__selfbase")) invalid(`tables.${name}[${index}] must be a row object`);
      validateValue(row, `tables.${name}[${index}]`, 0);
      const key = row[keyField];
      let normalized: string;
      if (keyField === "identity") {
        if (!object(key) || key.__selfbase !== "identity" || typeof key.v !== "string") invalid(`${name}[${index}]: missing identity`);
        normalized = key.v.toLowerCase();
      } else {
        const raw = object(key) && key.__selfbase === "bigint" ? key.v : key;
        if ((typeof raw !== "string" || !/^\d+$/.test(raw)) &&
            (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)) invalid(`${name}[${index}]: invalid ${keyField}`);
        if (typeof raw === "string" && raw.length > 20) invalid(`${name}[${index}]: ${keyField} exceeds u64`);
        const id = BigInt(raw as string | number);
        if (id === 0n) invalid(`${name}[${index}]: ${keyField} must be nonzero`);
        if (id > 18_446_744_073_709_551_615n) invalid(`${name}[${index}]: ${keyField} exceeds u64`);
        normalized = id.toString();
      }
      if (keys.has(normalized)) invalid(`${name}: duplicate ${keyField} ${normalized}`);
      keys.add(normalized);
    }
  }
}

function validateValue(value: unknown, path: string, depth: number): void {
  if (depth > 128) invalid(`${path}: nesting exceeds 128 levels`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((item, i) => validateValue(item, `${path}[${i}]`, depth + 1)); return; }
  if (!object(value)) invalid(`${path}: not a JSON value`);
  if (Object.hasOwn(value, "__selfbase")) {
    const data = value.v;
    if (typeof data !== "string") invalid(`${path}: invalid tagged value`);
    switch (value.__selfbase) {
      case "bigint": case "timestamp":
        if (!/^-?\d+$/.test(data)) invalid(`${path}: invalid ${value.__selfbase}`);
        if (value.__selfbase === "timestamp" && (data.length > 20 || BigInt(data) < -9_223_372_036_854_775_808n || BigInt(data) > 9_223_372_036_854_775_807n)) invalid(`${path}: timestamp exceeds i64`);
        break;
      case "identity":
        if (!/^[a-fA-F0-9]{64}$/.test(data)) invalid(`${path}: invalid identity`);
        break;
      case "bytes":
        if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid(`${path}: invalid base64 bytes`);
        // Standard base64 also requires zero padding bits; Rust's decoder is strict.
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        if ((data.endsWith("==") && (alphabet.indexOf(data.at(-3)!) & 15) !== 0) ||
            (!data.endsWith("==") && data.endsWith("=") && (alphabet.indexOf(data.at(-2)!) & 3) !== 0)) invalid(`${path}: invalid base64 padding`);
        break;
      default: invalid(`${path}: unknown encoding ${String(value.__selfbase)}`);
    }
    return;
  }
  // SDK optional columns use undefined; JSON.stringify omits those fields.
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) validateValue(item, `${path}.${key}`, depth + 1);
  }
}
