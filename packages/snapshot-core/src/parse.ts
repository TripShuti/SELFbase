import { PEAR_SNAPSHOT_FORMAT_V2, type PearSnapshotV2 } from "./v2";

export type ParsedPearSnapshot = {
  format: typeof PEAR_SNAPSHOT_FORMAT_V2;
  snapshot: PearSnapshotV2;
};

/**
 * Parse a pear-snapshot-v2 file (sniffed via the `format` field).
 * Returns the snapshot; rejects anything else with a clear error.
 */
export function parsePearSnapshotJson(text: string): ParsedPearSnapshot {
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

  if (o.format === PEAR_SNAPSHOT_FORMAT_V2) {
    if (!o.tables || typeof o.tables !== "object") {
      throw new Error("Invalid pear-snapshot-v2 file: missing tables");
    }
    if (!o.counts || typeof o.counts !== "object") {
      throw new Error("Invalid pear-snapshot-v2 file: missing counts");
    }
    return { format: PEAR_SNAPSHOT_FORMAT_V2, snapshot: o as PearSnapshotV2 };
  }

  throw new Error(
    `Unsupported snapshot format: ${JSON.stringify(o.format ?? null)} ` +
      `(expected "${PEAR_SNAPSHOT_FORMAT_V2}")`
  );
}
