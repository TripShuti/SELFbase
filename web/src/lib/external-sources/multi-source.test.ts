import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SOURCE, parseSourceConfigs, sourceForLink, type SourceConfig } from "./types";
import { fetchRecord, invalidateSourceCache, runSourceWorkerCycle, searchSource, workerStatus, type LoadedSource } from "./server";
import { mappedValues } from "./mapping";
import type { StdbTransport } from "../api-endpoint/types";
let seq = 0;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function source(overrides: Partial<SourceConfig> = {}): LoadedSource {
  return { config: { ...EMPTY_SOURCE, sourceId: "test-" + ++seq, baseUrl: "http://inventory:8080", recordMode: "collection", syncMode: "interval",
    syncIntervalSeconds: 3600, searchPath: "/catalog", resultsPath: "response.games", idPath: "appid", labelPath: "name",
    mappings: [{ sourcePath: "minutes", targetPropertyId: "10", targetType: "Duration", transform: "identity" }], ...overrides }, secret: "private-key" };
}
function body(minutes = 120) { return { response: { games: Array.from({ length: 80 }, (_, i) => ({ appid: i + 1, name: "Game " + (i + 1), minutes })) } }; }
describe("collection sources in memory", () => {
  it("searches beyond the first 50 results, finds numeric IDs and shares one fetch", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(body()));
    vi.stubGlobal("fetch", fetch);
    const s = source();
    expect((await searchSource(s, "Game 80"))[0].id).toBe("80");
    expect((await fetchRecord(s, "80")).values[0].value).toBe("120");
    await Promise.all([searchSource(s, "Game 3"), fetchRecord(s, "3")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("http://inventory:8080/catalog");
  });
  it("expires, force-refreshes and isolates changed credentials", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => Response.json(body()));
    vi.stubGlobal("fetch", fetch);
    const s = source();
    await fetchRecord(s, "1");
    vi.advanceTimersByTime(3600_001);
    await fetchRecord(s, "1");
    invalidateSourceCache(s);
    await fetchRecord(s, "1");
    await fetchRecord({ ...s, secret: "different-key" }, "1");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("does not mix two sources with the same external ID or cache a failed response", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(body()));
    vi.stubGlobal("fetch", fetch);
    const a = source(), b = source();
    await fetchRecord(a, "1"); await fetchRecord(b, "1");
    expect(fetch).toHaveBeenCalledTimes(2);
    invalidateSourceCache(a);
    fetch.mockResolvedValueOnce(new Response("private-key", { status: 403 }));
    await expect(fetchRecord(a, "1")).rejects.toThrow("HTTP 403");
    await fetchRecord(a, "1");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("rejects missing records and ambiguous or unavailable collections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(body())));
    const s = source();
    await expect(fetchRecord(s, "999")).rejects.toThrow("not present");
    invalidateSourceCache(s);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ response: {} })));
    await expect(fetchRecord(s, "1")).rejects.toThrow("visibility");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ response: { games: [{ appid: 1, name: "A" }, { appid: 1, name: "B" }] } })));
    await expect(fetchRecord(s, "1")).rejects.toThrow("duplicate");
  });
  it("keeps zero timestamps empty without suppressing a valid zero count", () => {
    expect(mappedValues({ time: 0, count: 0 }, { ...EMPTY_SOURCE, mappings: [
      { sourcePath: "time", targetPropertyId: "1", targetType: "Date", transform: "unixSecondsToMillis", zeroIsEmpty: true },
      { sourcePath: "count", targetPropertyId: "2", targetType: "Number", transform: "identity" },
    ] })).toEqual([{ propertyId: "2", kind: "Number", value: 0 }]);
  });
  it("resolves old untagged links to the primary source and explicit links to their source", () => {
    const a = { ...source().config, linkPropertyId: "50" }, b = { ...source().config, linkPropertyId: "50" };
    const configs = parseSourceConfigs(JSON.stringify({ externalSource: a, externalSources: [b] }));
    expect(configs).toHaveLength(2);
    expect(sourceForLink(configs, '{"id":"1","label":"Old"}')?.sourceId).toBe(a.sourceId);
    expect(sourceForLink(configs, JSON.stringify({ id: "1", label: "Other", sourceId: b.sourceId }))?.sourceId).toBe(b.sourceId);
  });
});
function workerFixture(mode: "manual" | "interval" | "change" = "interval") {
  const s = source({ syncMode: mode, changePath: "/status", changeValuePath: "last.revision", changeSuccessPath: "last.state", changeSuccessValue: "success" });
  const settings = { ...s.config, revision: "settings-v1", mappings: [], linkPropertyId: "" };
  const configs = [1, 2].map(id => ({ ...s.config, linkPropertyId: String(id * 50), revision: "binding-" + id,
    mappings: [{ sourcePath: "minutes", targetPropertyId: String(id * 10), targetType: "Duration", transform: "identity" }] }));
  const schema = (id: number) => ({ page_id: id, config: JSON.stringify({ externalSource: configs[id - 1] }) });
  const linked = new Set([101, 102]);
  const synced = new Map<number, string>();
  const transport: StdbTransport = {
    sql: vi.fn(async (q: string, args: unknown[] = []) => {
      if (q.includes("workspace_setting")) return [{ value_json: JSON.stringify(settings) }];
      if (q.includes("shared_external_source_secret")) return [{ secret: s.secret, scope: JSON.stringify([s.config.baseUrl, s.config.authHeader, s.config.authPrefix]) }];
      if (q.includes("database_schema")) return q.includes("WHERE") ? [schema(Number(args[0]))] : [schema(1), schema(2)];
      if (q.includes("FROM page ")) return [{ id: Number(args[0]) + 100, deleted_at: { none: [] } }];
      if (q.includes("page_property_value")) {
        const rowId = Number(args[0]) / 50 + 100;
        return linked.has(rowId) ? [{ page_id: rowId, value: { Text: JSON.stringify({ id: "1", label: "Game 1", syncedRevision: synced.get(rowId) }) } }] : [];
      }
      throw Error(q);
    }) as StdbTransport["sql"],
    call: vi.fn(async (_name: string, args: unknown[]) => { synced.set(Number(args[0]), JSON.parse(String(args[1])).revision); }),
  };
  return { transport, settings, configs, linked, synced };
}
describe("one refresh schedule per shared source", () => {
  it("applies the new upstream revision after an early mapping edit without reusing an old collection", async () => {
    const { transport, configs } = workerFixture("change");
    let revision = "v1", minutes = 120;
    const fetch = vi.fn(async (url: URL) => Response.json(String(url).endsWith("/status") ? { last: { revision, state: "success" } } : body(minutes)));
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    revision = "v2"; minutes = 240; configs[0].revision = "edited";
    await runSourceWorkerCycle(transport, now + 60_000);
    const last = vi.mocked(transport.call).mock.calls.at(-1)!;
    expect(JSON.parse(String(last[1][4]))[0].value).toBe("240");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/catalog"))).toHaveLength(2);
    await runSourceWorkerCycle(transport, now + 3_660_001);
    expect(transport.call).toHaveBeenCalledTimes(4);
  });
  it("retries a newly linked row even when the upstream revision has not changed", async () => {
    const { transport, linked } = workerFixture("change");
    linked.clear();
    const fetch = vi.fn(async (url: URL) => Response.json(String(url).endsWith("/status") ? { last: { revision: "v1", state: "success" } } : body()));
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    linked.add(101);
    await runSourceWorkerCycle(transport, now + 60_000);
    expect(transport.call).toHaveBeenCalledTimes(1);
    await runSourceWorkerCycle(transport, now + 120_000);
    expect(transport.call).toHaveBeenCalledTimes(1);
  });
  it("backs off failed row writes while keeping their links pending", async () => {
    const { transport, synced } = workerFixture("change");
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => Response.json(String(url).endsWith("/status") ? { last: { revision: "v1", state: "success" } } : body())));
    const original = transport.call;
    vi.mocked(transport.call).mockImplementationOnce(async () => { throw Error("write failed"); });
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    expect(synced.has(101)).toBe(false);
    const count = vi.mocked(original).mock.calls.length;
    await runSourceWorkerCycle(transport, now + 60_000);
    expect(original).toHaveBeenCalledTimes(count);
    await runSourceWorkerCycle(transport, now + 300_001);
    expect(synced.has(101)).toBe(true);
  });
  it("reports disabled connections as inactive", async () => {
    const { transport, configs } = workerFixture();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body())));
    await runSourceWorkerCycle(transport);
    configs[0].enabled = false;
    await runSourceWorkerCycle(transport);
    expect(workerStatus("1", configs[0].sourceId).automaticSync).toBe(false);
  });
  it("fetches a collection once for two databases and preserves each mapping's destination IDs", async () => {
    const { transport } = workerFixture();
    const fetch = vi.fn().mockImplementation(async () => Response.json(body()));
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.call).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(transport.call).mock.calls;
    expect(JSON.parse(String(calls[0][1][4]))[0].propertyId).toBe("10");
    expect(JSON.parse(String(calls[1][1][4]))[0].propertyId).toBe("20");
    await runSourceWorkerCycle(transport, now + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runSourceWorkerCycle(transport, now + 3_600_001);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("backs off a failed status check instead of retrying every worker tick", async () => {
    const { transport } = workerFixture("change");
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runSourceWorkerCycle(transport, now + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runSourceWorkerCycle(transport, now + 300_001);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("shares primary and additional list requests across two databases with distinct mappings", async () => {
    const { transport, configs, settings } = workerFixture();
    const enrichments = [{path:"/activity",resultsPath:"events",recordMatchPath:"appid",matchPath:"appid",targetField:"activity"}];
    Object.assign(settings,{enrichments});
    for(const config of configs) Object.assign(config,{enrichments,mappings:[...config.mappings,{sourcePath:"activity.first",targetPropertyId:String(Number(config.linkPropertyId)+1),targetType:"Date",transform:"unixSecondsToMillis"}]});
    const fetch=vi.fn(async(url:URL)=>Response.json(String(url).endsWith("/activity")?{events:[{appid:1,first:1767225600}]}:body()));
    vi.stubGlobal("fetch",fetch);
    await runSourceWorkerCycle(transport);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(transport.call).toHaveBeenCalledTimes(2);
    for(const [index,call] of vi.mocked(transport.call).mock.calls.entries()) expect(JSON.parse(String(call[1][4]))).toContainEqual({propertyId:String((index+1)*50+1),kind:"Date",value:"1767225600000"});
  });
  it("does not poll a manual source", async () => {
    const { transport, configs } = workerFixture("manual");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await runSourceWorkerCycle(transport);
    expect(fetch).not.toHaveBeenCalled();
    expect(workerStatus("1", configs[0].sourceId).automaticSync).toBe(false);
  });
  it("checks status once for all databases and reads games only after a new successful revision", async () => {
    const { transport } = workerFixture("change");
    let revision = "v1", state = "success";
    const fetch = vi.fn().mockImplementation(async (url: URL) => Response.json(String(url).endsWith("/status") ? { last: { revision, state } } : body()));
    vi.stubGlobal("fetch", fetch);
    const now = Date.now();
    await runSourceWorkerCycle(transport, now);
    expect(fetch).toHaveBeenCalledTimes(2);
    await runSourceWorkerCycle(transport, now + 3_600_001);
    expect(fetch).toHaveBeenCalledTimes(3);
    state = "running"; revision = "v2";
    await runSourceWorkerCycle(transport, now + 7_200_002);
    expect(fetch).toHaveBeenCalledTimes(4);
    state = "success";
    await runSourceWorkerCycle(transport, now + 10_800_003);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(transport.call).toHaveBeenCalledTimes(4);
  });
});
