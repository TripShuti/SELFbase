import { chunkSelfbaseSnapshotV2, type SelfbaseSnapshotV2 } from "./v2";

export interface SnapshotRestoreReducers {
  importV2Begin(args: { headerJson: string }): Promise<void>;
  importV2Chunk(args: { seq: number; tableName: string; rowsJson: string }): Promise<void>;
  importV2Commit(args: { manifestJson: string }): Promise<void>;
}

/** No automatic retry or abort: a lost acknowledgement can follow a committed write. */
export async function restoreSelfbaseSnapshotV2(
  snapshot: SelfbaseSnapshotV2,
  reducers: SnapshotRestoreReducers,
  options: { onProgress?: (done: number, total: number) => void; timeoutMs?: number } = {},
): Promise<void> {
  // Finish all local preflight/serialization before touching the destination.
  const { header, chunks, manifest } = chunkSelfbaseSnapshotV2(snapshot);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid restore timeout");
  let phase = "begin";
  let confirmed = 0;
  const call = async (operation: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Import request timed out; server outcome is unknown")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  options.onProgress?.(0, chunks.length);
  try {
    await call(() => reducers.importV2Begin({ headerJson: JSON.stringify(header) }));
    phase = "chunk";
    for (const chunk of chunks) {
      await call(() => reducers.importV2Chunk({ seq: chunk.seq, tableName: chunk.tableName, rowsJson: chunk.rowsJson }));
      confirmed++;
      options.onProgress?.(confirmed, chunks.length);
    }
    phase = "commit";
    await call(() => reducers.importV2Commit({ manifestJson: JSON.stringify(manifest) }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (phase === "begin") throw new Error(`Import start was not confirmed: ${detail}. No automatic abort was sent; check the destination's existing session before retrying.`);
    throw new Error(`Import ${phase} was not confirmed after ${confirmed}/${chunks.length} chunks: ${detail}. Earlier chunks may already be stored; abort does not roll them back. Verify the destination before retrying. If it is incomplete, restore into a fresh empty database or explicitly clear the failed restore target. The session was not automatically aborted.`);
  }
}
