import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SOURCE, type SourceMapping, type RelatedDate } from "./types";
import { mappedValues, latestDate } from "./mapping";
import { fetchRecord, fetchRelatedDate } from "./server";

const status: SourceMapping = {
  sourcePath: "state", targetPropertyId: "2", targetType: "Select", transform: "statusRules",
  rules: [
    { path: "state.complete", operator: "equals", value: "true", result: "Done" },
    { path: "state.progress", operator: "greaterThan", value: "0", result: "Active" },
    { path: "state.lastSeen", operator: "exists", value: "", result: "Active" },
  ], defaultValue: "Not started", preserveValues: ["Paused"],
};
const related: RelatedDate = { path: "/records/{id}/events", resultsPath: "entries", valuePath: "seenAt",
  whenPath: "kind", whenEquals: "collection", offsetParam: "offset", limitParam: "limit", totalPath: "total", pageSize: 2 };
const date: SourceMapping = { sourcePath: "state.lastSeen", targetPropertyId: "3", targetType: "Date", transform: "isoDateToMillis", related };
const source = { config: { ...EMPTY_SOURCE, baseUrl: "http://catalog:8080", detailPath: "/records/{id}", idPath: "sku", labelPath: "label", mappings: [status, date] }, secret: "key" };
afterEach(() => vi.unstubAllGlobals());
describe("conditional source statuses", () => {
  const convert = (state: unknown) => mappedValues({ state }, { ...EMPTY_SOURCE, mappings: [status] });
  it("gives completion priority and handles in-progress and unstarted records", () => {
    expect(convert({ complete: true, progress: 50 })[0].value).toBe("Done");
    expect(convert({ complete: false, progress: 50 })[0].value).toBe("Active");
    expect(convert({ complete: false, progress: 0 })[0].value).toBe("Not started");
    expect(convert({ lastSeen: "2026-01-01T00:00:00Z" })[0].value).toBe("Active");
  });
  it("preserves missing user data rather than inventing an unstarted state", () => {
    expect(convert(null)).toEqual([]);
    expect(mappedValues({}, { ...EMPTY_SOURCE, mappings: [status] })).toEqual([]);
  });
});
describe("related date aggregation", () => {
  it("selects dates by instant, handles nulls and rejects malformed dates", () => {
    expect(latestDate([null, "", "2026-01-01T04:00:00+03:00", "2026-01-01T02:00:00Z"])).toBe("2026-01-01T02:00:00.000Z");
    expect(latestDate([null])).toBeNull();
    expect(() => latestDate(["broken"])).toThrow("invalid date");
  });
  it("reads every page, authenticates same-origin requests and uses the newest date", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ sku: "abc", label: "Series", kind: "collection", state: { complete: false, progress: 50 } }))
      .mockResolvedValueOnce(Response.json({ entries: [{ seenAt: "2026-01-01Z" }, { seenAt: null }], total: 3 }))
      .mockResolvedValueOnce(Response.json({ entries: [{ seenAt: "2026-02-01T00:00:00Z" }], total: 3 }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchRecord(source, "abc");
    expect(result.values).toEqual([{ propertyId: "2", kind: "Select", value: "Active" }, { propertyId: "3", kind: "Date", value: String(Date.parse("2026-02-01T00:00:00Z")) }]);
    expect(String(fetch.mock.calls[2][0])).toBe("http://catalog:8080/records/abc/events?offset=2&limit=2");
    expect(fetch.mock.calls[2][1].headers.get("Authorization")).toBe("Bearer key");
  });
  it("uses the primary date for other item types and avoids an irrelevant request", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sku: "abc", label: "Movie", kind: "single", state: { lastSeen: "2026-01-01T00:00:00Z" } }));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchRecord(source, "abc")).values[1].value).toBe(String(Date.parse("2026-01-01T00:00:00Z")));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps dates when related values are null, and keeps the later primary date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ entries: [{ seenAt: null }], total: 1 })));
    expect(await fetchRelatedDate(source, "abc", related)).toBeNull();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ sku: "abc", label: "Collection", kind: "collection", state: { lastSeen: "2026-03-01T00:00:00Z" } }))
      .mockResolvedValueOnce(Response.json({ entries: [{ seenAt: "2026-02-01T00:00:00Z" }], total: 1 }));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchRecord(source, "abc")).values[1].value).toBe(String(Date.parse("2026-03-01T00:00:00Z")));
  });
  it("rejects incomplete collections and pagination overflow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ entries: [], total: 5 })));
    await expect(fetchRelatedDate(source, "abc", related)).rejects.toThrow("incomplete");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ entries: [{ seenAt: null }], total: 100 })));
    await expect(fetchRelatedDate(source, "abc", related)).rejects.toThrow("pagination limit");
  });
  it("lets the latest child activity drive a parent status even before any child is completed", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sku: "abc", label: "Collection", kind: "collection", state: { complete: false, progress: 0 } }))
      .mockResolvedValueOnce(Response.json({ entries: [{ seenAt: "2026-02-01T00:00:00Z" }], total: 1 })));
    expect((await fetchRecord(source, "abc")).values[0].value).toBe("Active");
  });
  it("does not write partial snapshots when a related request fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ sku: "abc", label: "Collection", kind: "collection", state: { complete: true } }))
      .mockResolvedValueOnce(new Response("secret", { status: 503 })));
    await expect(fetchRecord(source, "abc")).rejects.toThrow("HTTP 503");
  });
});
