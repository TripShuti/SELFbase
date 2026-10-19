import * as Y from "yjs";

/** Compare canonical states, including deletion sets (state vectors omit them). */
export function hasUnsavedChanges(doc: Y.Doc, serverState: Uint8Array): boolean {
  const merged = new Y.Doc();
  try {
    Y.applyUpdate(merged, serverState);
    const before = Y.encodeStateAsUpdate(merged);
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc));
    const after = Y.encodeStateAsUpdate(merged);
    return before.length !== after.length || before.some((byte, index) => byte !== after[index]);
  } finally {
    merged.destroy();
  }
}
