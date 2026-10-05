"use client";

// SELFbase portable snapshot formats now live in the shared workspace package
// @selfbase/snapshot-core (packages/snapshot-core). This module re-exports
// them and keeps only the browser-specific download helper.

export {
  // shared encoding
  encodeSnapshotValue,
  // v2
  SELFBASE_SNAPSHOT_FORMAT_V2,
  SNAPSHOT_TABLE_POLICY_V2,
  SNAPSHOT_TABLES_V2,
  SNAPSHOT_EXCLUDED_TABLES_V2,
  buildSelfbaseSnapshotV2,
  chunkSelfbaseSnapshotV2,
  resolveSnapshotTableAccessors,
  parseSelfbaseSnapshotJson,
} from "@selfbase/snapshot-core";
export type {
  SelfbaseSnapshotV2,
  SelfbaseSnapshotV2Chunk,
  SelfbaseSnapshotV2Header,
  SelfbaseSnapshotV2Manifest,
  SelfbaseSnapshotV2Meta,
  ChunkedSelfbaseSnapshotV2,
  ParsedSelfbaseSnapshot,
  SnapshotTableRegistry,
  SnapshotTableRegistryEntry,
} from "@selfbase/snapshot-core";

import type { SelfbaseSnapshotV2 } from "@selfbase/snapshot-core";

/** Browser-only: serialize a snapshot and trigger a file download. */
export function downloadSelfbaseSnapshotJson(
  snapshot: SelfbaseSnapshotV2,
  filenameHint?: string
): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameHint ?? `pear-snapshot-${snapshot.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
