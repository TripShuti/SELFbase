import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ send: vi.fn(), authorize: vi.fn() }));
vi.mock("@/src/lib/s3", () => ({ isS3Configured: () => true, getS3Bucket: () => "bucket", getS3Client: () => ({ send: mocks.send }) }));
vi.mock("../../app/api/upload/_auth", () => ({ authorizeBlobRequest: mocks.authorize, pageIdFromKey: () => 1 }));
import { PUT } from "../../app/api/upload/put/route";

function request(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const init = { method: "PUT", body, headers, signal, duplex: "half" };
  return new NextRequest("http://localhost/api/upload/put?db=selfbase&key=pages/1/file.bin", init);
}
beforeEach(() => { mocks.send.mockReset().mockResolvedValue({}); mocks.authorize.mockReset().mockResolvedValue(null); });
describe("upload PUT streaming gate", () => {
  it("uploads a chunked body without Content-Length and forwards cancellation to S3", async () => {
    const response = await PUT(request(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close();
    } })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storageKey: "pages/1/file.bin", byteSize: 3 });
    expect(mocks.send.mock.calls[0][0].input.Body).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it.each(["-1", "nope", "1.5", "9007199254740992"])("rejects invalid declared length %s", async length => {
    expect((await PUT(request("x", { "content-length": length }))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects an oversized declaration and an empty upload", async () => {
    expect((await PUT(request("x", { "content-length": String(100 * 1024 * 1024 + 1) }))).status).toBe(413);
    expect((await PUT(request(""))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("cancels a stalled body when the client disconnects", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = PUT(request(new ReadableStream({ cancel }), {}, controller.signal));
    controller.abort();
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("authorizes before reading and never stores denied uploads", async () => {
    mocks.authorize.mockResolvedValue(new NextResponse(null, { status: 403 }));
    expect((await PUT(request("secret"))).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([{}, { "content-length": "1" }])("limits actual bytes independently of headers %j", async headers => {
    const chunk = new Uint8Array(1024 * 1024);
    const cancel = vi.fn();
    const response = await PUT(request(new ReadableStream({
      pull(c) { c.enqueue(chunk); }, cancel,
    }), headers as Record<string, string>));
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("times out a stalled body and cancels its reader", async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    try {
      const result = PUT(request(new ReadableStream({ cancel })));
      controller.abort(new DOMException("Deadline", "TimeoutError"));
      expect((await result).status).toBe(408);
      expect(cancel).toHaveBeenCalledOnce();
      expect(mocks.send).not.toHaveBeenCalled();
    } finally { deadline.mockRestore(); }
  });

  it("aborts forwarding to S3 when the caller disconnects", async () => {
    const controller = new AbortController();
    mocks.send.mockImplementation(async (_command, options) => {
      controller.abort();
      options.abortSignal.throwIfAborted();
    });
    expect((await PUT(request("hello", {}, controller.signal))).status).toBe(408);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

});
