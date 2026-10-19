import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { hasUnsavedChanges } from "./hasUnsavedChanges";

describe("snapshot reconciliation", () => {
  it("does not echo a server snapshot or an equivalent merged encoding", () => {
    const server = new Y.Doc();
    server.getText("text").insert(0, "hello");
    const first = Y.encodeStateAsUpdate(server);
    const client = new Y.Doc();
    Y.applyUpdate(client, first);
    expect(hasUnsavedChanges(client, first)).toBe(false);
    server.getText("text").insert(5, " world");
    const update = Y.encodeStateAsUpdate(server, Y.encodeStateVector(client));
    Y.applyUpdate(client, update);
    expect(hasUnsavedChanges(client, Y.mergeUpdates([first, update]))).toBe(false);
    server.destroy(); client.destroy();
  });

  it("detects local deletions despite equal state vectors", () => {
    const doc = new Y.Doc();
    doc.getText("text").insert(0, "hello");
    const server = Y.encodeStateAsUpdate(doc);
    doc.getText("text").delete(0, 5);
    expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVectorFromUpdate(server));
    expect(hasUnsavedChanges(doc, server)).toBe(true);
    expect(hasUnsavedChanges(doc, Y.encodeStateAsUpdate(doc))).toBe(false);
    doc.destroy();
  });

  it("detects an overwritten concurrent write and converges after repair", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("text").insert(0, "A");
    b.getText("text").insert(0, "B");
    const overwrittenServer = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, overwrittenServer, "remote");
    expect(hasUnsavedChanges(a, overwrittenServer)).toBe(true);
    const repairedServer = Y.encodeStateAsUpdate(a);
    Y.applyUpdate(b, repairedServer, "remote");
    expect(b.getText("text").toString()).toBe(a.getText("text").toString());
    expect(hasUnsavedChanges(a, repairedServer)).toBe(false);
    expect(hasUnsavedChanges(b, repairedServer)).toBe(false);
    a.destroy(); b.destroy();
  });
});
