import { afterEach, describe, expect, it, vi } from "vitest";
import { externalSourceFetch } from "./client";
import { setWorkspaceSessionToken, tokenStorageKey } from "../workspaceConnections";
import { buildConnectionBuilder } from "../spacetime";

const workspace = { id: "auth-test", name: "Test", wsUri: "ws://fixture", dbName: "selfbase" };

function storage() {
  const values = new Map([
    ["selfbase_workspaces_v1", JSON.stringify([{ id: "auth-test", name: "Test", wsUri: "ws://fixture", dbName: "selfbase" }])],
    ["selfbase_active_workspace_id", "auth-test"],
    [tokenStorageKey("auth-test"), "old-native-token"],
  ]);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null });
  return values;
}
afterEach(() => { setWorkspaceSessionToken("auth-test", undefined); vi.unstubAllGlobals(); });
describe("external source HTTP authentication", () => {
  it("uses the current OIDC token and its renewed value without persisting either", async () => {
    const values = storage();
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ records: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(buildConnectionBuilder("oidc-token-1", workspace, () => {})).not.toBeNull();
    await externalSourceFetch("selfbase", 1n);
    expect(buildConnectionBuilder("oidc-token-2", workspace, () => {})).not.toBeNull();
    await externalSourceFetch("selfbase", 1n);
    expect(fetch.mock.calls.map(call => new Headers(call[1]?.headers).get("Authorization")))
      .toEqual(["Bearer oidc-token-1", "Bearer oidc-token-2"]);
    expect(values.get(tokenStorageKey("auth-test"))).toBe("old-native-token");
  });
  it("never falls back to a stale native identity during OIDC logout or renewal", async () => {
    storage();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(buildConnectionBuilder(undefined, workspace, () => {})).toBeNull();
    await expect(externalSourceFetch("selfbase", 1n)).rejects.toThrow("Sign in");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps native login working and scopes OIDC tokens to their workspace", async () => {
    storage();
    setWorkspaceSessionToken("other-workspace", "other-oidc-token");
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer old-native-token");
      return Response.json({ records: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await externalSourceFetch("selfbase", 1n);
    setWorkspaceSessionToken("other-workspace", undefined);
  });
});
