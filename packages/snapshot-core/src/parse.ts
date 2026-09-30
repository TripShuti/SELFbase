import { SELFBASE_SNAPSHOT_FORMAT_V2, type SelfbaseSnapshotV2 } from "./v2";

export type ParsedSelfbaseSnapshot = {
  format: typeof SELFBASE_SNAPSHOT_FORMAT_V2;
  snapshot: SelfbaseSnapshotV2;
};

/**
 * Parse a selfbase-snapshot-v2 file (sniffed via the `format` field).
 * Returns the snapshot; rejects anything else with a clear error.
 */
export function parseSelfbaseSnapshotJson(text: string): ParsedSelfbaseSnapshot {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("Invalid snapshot: file is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid snapshot: expected a JSON object");
  }
  const o = v as Record<string, unknown>;

  if (o.format === SELFBASE_SNAPSHOT_FORMAT_V2) {
    if (!o.tables || typeof o.tables !== "object") {
      throw new Error("Invalid selfbase-snapshot-v2 file: missing tables");
    }
    if (!o.counts || typeof o.counts !== "object") {
      throw new Error("Invalid selfbase-snapshot-v2 file: missing counts");
    }
    return { format: SELFBASE_SNAPSHOT_FORMAT_V2, snapshot: o as SelfbaseSnapshotV2 };
  }

  throw new Error(
    `Unsupported snapshot format: ${JSON.stringify(o.format ?? null)} ` +
      `(expected "${SELFBASE_SNAPSHOT_FORMAT_V2}")`
  );
}
