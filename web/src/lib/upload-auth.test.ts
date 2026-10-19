import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeBlobRequest } from "../../app/api/upload/_auth";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("blob workspace isolation", () => {
  it("checks the caller's access in the configured database", async () => {
    vi.stubEnv("SELFBASE_STDB_DB_NAME", "trusted-workspace");
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("", { status: 200 })); vi.stubGlobal("fetch", fetch);
    const response = await authorizeBlobRequest(new Request("http://localhost/api/upload/proxy", {
      headers: { Authorization: "Bearer test-token" },
    }), "trusted-workspace", 1, true);
    expect(response).toBeNull();
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/trusted-workspace/call/authorize_blob_access");
  });
  it("rejects another database before calling its authorization reducer", async () => {
    vi.stubEnv("SELFBASE_STDB_DB_NAME", "trusted-workspace");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await authorizeBlobRequest(new Request("http://localhost/api/upload/proxy", {
      headers: { Authorization: "Bearer test-token" },
    }), "attacker-workspace", 1, false);
    expect(response?.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
