import { describe, expect, it, vi } from "vitest";
import { chunkSelfbaseSnapshotV2, parseSelfbaseSnapshotJson, restoreSelfbaseSnapshotV2, SNAPSHOT_TABLES_V2, type SelfbaseSnapshotV2 } from "@selfbase/snapshot-core";
import { tables } from "../module_bindings";

function snapshot(): SelfbaseSnapshotV2 {
  return { format: "selfbase-snapshot-v2", exportedAt: "2026-10-19T00:00:00Z", workspace: { wsUri: "ws://test", dbName: "test" },
    tables: Object.fromEntries(SNAPSHOT_TABLES_V2.map(name => [name, []])),
    counts: Object.fromEntries(SNAPSHOT_TABLES_V2.map(name => [name, 0])), blobManifest: { storageKeys: [] } };
}
function withRows() {
  const value = snapshot();
  value.tables.page = [{ id: { __selfbase: "bigint", v: "9007199254740993" } }]; value.counts.page = 1;
  value.tables.workspace_setting = [{ id: 1 }]; value.counts.workspace_setting = 1;
  return value;
}
const read = (value: unknown) => parseSelfbaseSnapshotJson(JSON.stringify(value));

describe("snapshot preflight", () => {
  it("accepts complete empty exports and preserves bigint IDs losslessly", () => {
    expect(read(snapshot()).snapshot.counts.page).toBe(0);
    expect(chunkSelfbaseSnapshotV2(withRows()).chunks[0].rowsJson).toContain("9007199254740993");
  });
  it.each(["tables", "counts"])("rejects arrays and missing/unknown table entries in %s", field => {
    for (const bad of [[], null, {}, { ...snapshot()[field as "tables"], unknown: [] }]) {
      const value = { ...snapshot(), [field]: bad };
      expect(() => read(value)).toThrow();
    }
  });
  it.each([-1, 0.5, "1", null, 2, Number.MAX_SAFE_INTEGER + 1])("rejects inconsistent count %j", count => {
    const value = withRows(); value.counts.page = count as number;
    expect(() => read(value)).toThrow(/counts.page/);
  });
  it("keeps the prepared manifest and header independent of later input changes", () => {
    const value = withRows(); const prepared = chunkSelfbaseSnapshotV2(value);
    value.counts.page = 99; value.workspace.dbName = "changed";
    expect(prepared.manifest.counts.page).toBe(1);
    expect(prepared.header.workspace.dbName).toBe("test");
  });
  it("accepts SDK optional undefined columns before JSON serialization", () => {
    const value = snapshot(); value.tables.page = [{ id: 1, parentId: undefined }]; value.counts.page = 1;
    expect(chunkSelfbaseSnapshotV2(value).chunks[0].rowsJson).toBe('[{"id":1}]');
  });
  it("rejects malformed row shapes and unsafe or duplicate IDs before chunking", () => {
    for (const rows of [[null], [[]], ["row"], [{}], [{ id: Number.MAX_SAFE_INTEGER + 1 }], [{ id: "18446744073709551616" }], [{ id: -1 }], [{ id: 0 }], [{ id: 1 }, { id: { __selfbase: "bigint", v: "01" } }]]) {
      const value = snapshot(); value.tables.page = rows; value.counts.page = rows.length;
      expect(() => chunkSelfbaseSnapshotV2(value)).toThrow();
    }
  });
  it.each([
    { __selfbase: "bytes", v: "%%%" }, { __selfbase: "bytes", v: "Zh==" },
    { __selfbase: "timestamp", v: "9223372036854775808" }, { __selfbase: "identity", v: "abc" },
    { __selfbase: "timestamp", v: "yesterday" }, { __selfbase: "bigint", v: 1 }, { __selfbase: "unknown", v: "1" },
  ])("rejects malformed encoding %j", bad => {
    const value = snapshot(); value.tables.page = [{ id: 1, bad }]; value.counts.page = 1;
    expect(() => read(value)).toThrow();
  });
  it("rejects malformed metadata and blob manifests", () => {
    for (const patch of [{ exportedAt: "never" }, { workspace: [] }, { workspace: { dbName: "x", wsUri: "" } }, { moduleVersion: 1 }, { blobManifest: null }, { blobManifest: { storageKeys: [1] } }]) {
      expect(() => read({ ...snapshot(), ...patch })).toThrow();
    }
  });
  it("tracks primary keys in the actual generated bindings, including non-id keys", () => {
    for (const name of SNAPSHOT_TABLES_V2) {
      const entry = Object.values(tables).find(table => table.sourceName === name)!;
      const columns = entry.tableDef.columns as Record<string, { columnMetadata: { isPrimaryKey?: boolean } }>;
      const [key] = Object.keys(columns).filter(field => columns[field].columnMetadata?.isPrimaryKey);
      expect(key, name).toBeDefined();
      const value = snapshot();
      value.tables[name] = [{ [key]: key === "identity" ? { __selfbase: "identity", v: "a".repeat(64) } : 1 }];
      value.counts[name] = 1;
      expect(() => read(value), name).not.toThrow();
    }
  });
});

describe("restore failure boundaries", () => {
  const reducers = () => ({ importV2Begin: vi.fn().mockResolvedValue(undefined), importV2Chunk: vi.fn().mockResolvedValue(undefined), importV2Commit: vi.fn().mockResolvedValue(undefined), importV2Abort: vi.fn() });
  it("validates the entire file before calling any reducer", async () => {
    const target = reducers(); const value = withRows(); value.counts.workspace_setting = 7;
    await expect(restoreSelfbaseSnapshotV2(value, target)).rejects.toThrow(/counts.workspace_setting/);
    expect(target.importV2Begin).not.toHaveBeenCalled();
  });
  it("does not abort another session when begin fails", async () => {
    const target = reducers(); target.importV2Begin.mockRejectedValue(new Error("another session exists"));
    await expect(restoreSelfbaseSnapshotV2(withRows(), target)).rejects.toThrow(/start was not confirmed/);
    expect(target.importV2Abort).not.toHaveBeenCalled(); expect(target.importV2Chunk).not.toHaveBeenCalled();
  });
  it("stops at a failed chunk, retains the session and explains partial writes", async () => {
    const target = reducers(); target.importV2Chunk.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disconnected"));
    const progress = vi.fn();
    await expect(restoreSelfbaseSnapshotV2(withRows(), target, { onProgress: progress })).rejects.toThrow(/after 1\/2 chunks.*abort does not roll them back/);
    expect(target.importV2Commit).not.toHaveBeenCalled(); expect(target.importV2Abort).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2]]);
  });
  it("does not retry or abort a commit with an unknown outcome", async () => {
    const target = reducers(); target.importV2Commit.mockRejectedValue(new Error("lost acknowledgement"));
    await expect(restoreSelfbaseSnapshotV2(withRows(), target)).rejects.toThrow(/commit was not confirmed/);
    expect(target.importV2Commit).toHaveBeenCalledOnce(); expect(target.importV2Abort).not.toHaveBeenCalled();
  });
  it("bounds an unresolved SDK call without claiming rollback", async () => {
    const target = reducers(); target.importV2Chunk.mockReturnValue(new Promise(() => {}));
    await expect(restoreSelfbaseSnapshotV2(withRows(), target, { timeoutMs: 10 })).rejects.toThrow(/server outcome is unknown/);
    expect(target.importV2Abort).not.toHaveBeenCalled(); expect(target.importV2Commit).not.toHaveBeenCalled();
  });
  it("commits a valid complete manifest after all ordered chunks", async () => {
    const target = reducers(); await restoreSelfbaseSnapshotV2(withRows(), target);
    expect(target.importV2Chunk.mock.calls.map(([chunk]) => chunk.seq)).toEqual([1, 2]);
    expect(JSON.parse(target.importV2Commit.mock.calls[0][0].manifestJson).counts).toEqual(withRows().counts);
    expect(target.importV2Abort).not.toHaveBeenCalled();
  });
});
