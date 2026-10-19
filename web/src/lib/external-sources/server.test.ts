import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRecord, loadSource, searchSource, sourceUrl, syncSourceDatabase } from "./server";
import { EMPTY_SOURCE } from "./types";
import type { StdbTransport } from "../api-endpoint/types";
const config = { ...EMPTY_SOURCE, baseUrl: "http://inventory:8080", searchPath: "/v1/products", detailPath: "/v1/products/{id}",
  resultsPath: "data.items", idPath: "sku", labelPath: "label", linkPropertyId: "9", mappings: [
    { sourcePath: "stock", targetPropertyId: "10", targetType: "Number" as const, transform: "identity" as const },
  ] };
const source = { config, secret: "private-key" };
afterEach(() => vi.unstubAllGlobals());
describe("external HTTP source", () => {
  it("requires legacy credentials to match the restored endpoint, header and prefix", async () => {
    const storedScope = JSON.stringify([config.baseUrl, config.authHeader, config.authPrefix]);
    let scope: unknown = { some: storedScope };
    let current = { ...config };
    const transport = {
      sql: async (query: string) => query.includes("database_schema")
        ? [{ page_id: 1, config: JSON.stringify({ externalSource: current }) }]
        : [{ secret: "private-key", scope }],
      call: async () => {},
    } as unknown as StdbTransport;
    expect((await loadSource(transport, "1")).secret).toBe("private-key");
    for (const changed of [{ baseUrl: "http://another-host" }, { authHeader: "X-Key" }, { authPrefix: "Other " }]) {
      current = { ...config, ...changed };
      await expect(loadSource(transport, "1")).rejects.toThrow("scoped credential");
    }
    current = { ...config }; scope = { none: [] };
    await expect(loadSource(transport, "1")).rejects.toThrow("scoped credential");
  });
  it("queries the configured path and header and returns only display metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { items: [{ sku: "abc", label: "Lamp", stock: 12 }] } }));
    vi.stubGlobal("fetch", fetch);
    expect(await searchSource(source, "lamp & bulb")).toEqual([{ id: "abc", label: "Lamp", subtitle: "", image: "" }]);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://inventory:8080/v1/products?q=lamp+%26+bulb");
    expect(options.headers.get("Authorization")).toBe("Bearer private-key");
    expect(options.redirect).toBe("error");
  });
  it("rejects mismatched records and hides upstream error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ sku: "wrong", label: "X", stock: 3 })));
    await expect(fetchRecord(source, "abc")).rejects.toThrow("different record id");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-key", { status: 401 })));
    await expect(fetchRecord(source, "abc")).rejects.toThrow("HTTP 401");
  });
  it("rejects off-origin paths and oversized responses", async () => {
    expect(() => sourceUrl(config, "//evil/path")).toThrow();
    expect(() => sourceUrl(config, "/\\evil/path")).toThrow();
    await expect(fetchRecord(source, "..")).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(2_000_001))));
    await expect(fetchRecord(source, "abc")).rejects.toThrow("2 MB");
  });
  it("refreshes duplicate links with one fetch and skips trash/unlinked rows", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sku: "abc", label: "Lamp", stock: 12 }));
    vi.stubGlobal("fetch", fetch);
    const transport: StdbTransport = {
      sql: vi.fn().mockResolvedValueOnce([
        { id: 1, deleted_at: { none: [] } }, { id: 2, deleted_at: { none: [] } }, { id: 3, deleted_at: { some: [1] } }, { id: 4, deleted_at: { none: [] } },
      ]).mockResolvedValueOnce([1, 2, 3].map(id => ({ page_id: id, value: { Text: JSON.stringify({ id: "abc", label: "Old name" }) } }))),
      call: vi.fn().mockResolvedValue(undefined),
    };
    expect(await syncSourceDatabase(transport, "55", source)).toEqual({ updated: 2, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.call).toHaveBeenCalledTimes(2);
    expect(transport.call).toHaveBeenCalledWith("apply_external_record", [1, JSON.stringify(config), "abc", "Lamp", JSON.stringify([{ propertyId: "10", kind: "Number", value: 12 }])]);
  });
});
