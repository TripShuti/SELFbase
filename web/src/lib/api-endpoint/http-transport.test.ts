import { createServer } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { HttpStdbTransport } from "./http-transport";
const reply = (name: string, value: unknown) => new Response(JSON.stringify([
    { schema: { elements: [{ name: { some: name } }] }, rows: [[value]] },
]));
const create = (fetchImpl: typeof fetch, token = "actor-a") => new HttpStdbTransport({
    baseUrl: "http://localhost:3098", dbName: "fixture", token, fetchImpl,
});
describe("caller-scoped HTTP reads", () => {
    test("initializes only the required view and returns requested data", async () => {
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => String(init?.body).startsWith("SELECT COUNT") ? reply("count", 10) : reply("title", "Allowed"));
        const transport = create(fetchImpl as typeof fetch);
        await expect(transport.sql("SELECT title FROM page WHERE id = ?", [3])).resolves.toEqual([{ title: "Allowed" }]);
        expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual([
            "SELECT COUNT(*) AS count FROM readable_pages", "SELECT title FROM page WHERE id = 3",
        ]);
        await transport.sql("SELECT title FROM page");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
    test("coalesces initialization per transport, never across identities", async () => {
        const fetchImpl = vi.fn(async () => reply("id", 1));
        const first = create(fetchImpl as typeof fetch);
        await Promise.all([first.sql("SELECT * FROM page"), first.sql("SELECT * FROM page_content")]);
        const second = create(fetchImpl as typeof fetch, "actor-b");
        await second.sql("SELECT * FROM page");
        const preludes = fetchImpl.mock.calls.filter(([, init]: any) => String(init?.body).startsWith("SELECT COUNT"));
        expect(preludes).toHaveLength(2);
        expect(preludes.map(([, init]: any) => init.headers.Authorization)).toEqual(["Bearer actor-a", "Bearer actor-b"]);
    });
    test("fails closed and retries initialization after an error", async () => {
        let fail = true;
        const bodies: string[] = [];
        const transport = create((async (_url, init) => {
            bodies.push(String(init?.body));
            if (fail) {
                fail = false;
                return new Response("view unavailable", { status: 503 });
            }
            return reply("id", 1);
        }) as typeof fetch);
        await expect(transport.sql("SELECT * FROM page_snapshot")).rejects.toThrow("view unavailable");
        expect(bodies).toEqual(["SELECT COUNT(*) AS count FROM readable_pages"]);
        await expect(transport.sql("SELECT * FROM page_snapshot")).resolves.toEqual([{ id: 1 }]);
        expect(bodies).toHaveLength(3);
    });
    test("does not change unprotected identity/config reads", async () => {
        const fetchImpl = vi.fn(async () => reply("id", 4));
        await expect(create(fetchImpl as typeof fetch).sql("SELECT id FROM migration_state")).resolves.toEqual([{ id: 4 }]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

// Bodies deliberately ignore fetch's AbortSignal: timeout must cover consumers,
// including injected fetch implementations, rather than only native fetch.
describe("full-response deadline", () => {
    const timed = (fetchImpl: typeof fetch) => new HttpStdbTransport({
        baseUrl: "http://localhost:3098", dbName: "fixture", token: "actor", timeoutMs: 20, fetchImpl,
    });
    test.each([200, 503])("times out a stalled SQL body after HTTP %i headers", async status => {
        const transport = timed((async () => new Response(new ReadableStream({ start(c) {
            c.enqueue(new TextEncoder().encode("["));
        } }), { status })) as typeof fetch);
        await expect(transport.sql("SELECT * FROM migration_state")).rejects.toMatchObject({ status: 504, code: "stdb_timeout" });
    });
    test("times out a stalled reducer error body", async () => {
        const transport = timed((async () => new Response(new ReadableStream(), { status: 503 })) as typeof fetch);
        await expect(transport.call("change", [])).rejects.toMatchObject({ status: 504, code: "stdb_timeout" });
    });
    test("cancels an unused successful reducer body", async () => {
        const cancel = vi.fn();
        const transport = timed((async () => new Response(new ReadableStream({ cancel }))) as typeof fetch);
        await expect(transport.call("change", [])).resolves.toBeUndefined();
        expect(cancel).toHaveBeenCalledOnce();
    });
    test("bounds a fetch that never resolves", async () => {
        await expect(timed((() => new Promise(() => {})) as typeof fetch).call("change", []))
            .rejects.toMatchObject({ status: 504, code: "stdb_timeout" });
    });
});


test("native fetch closes a real stalled response when its body deadline expires", async () => {
    let bodyClosed!: () => void;
    const closed = new Promise<void>(resolve => { bodyClosed = resolve; });
    const server = createServer((_request, response) => {
        response.on("close", bodyClosed);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("[");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address() as { port: number };
        const transport = new HttpStdbTransport({ baseUrl: `http://127.0.0.1:${address.port}`, dbName: "fixture", token: "actor", timeoutMs: 200 });
        await expect(transport.sql("SELECT * FROM migration_state")).rejects.toMatchObject({ status: 504, code: "stdb_timeout" });
        await closed;
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
