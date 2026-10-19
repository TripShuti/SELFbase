import { describe, expect, it, vi } from "vitest";
import { BodyTooLargeError, readBoundedBody } from "./read-bounded-body";

const signal = () => new AbortController().signal;
describe("bounded body reading", () => {
  it("accepts an exact-limit body across chunks and releases its lock", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close();
    } });
    await expect(readBoundedBody(stream, 3, signal())).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(stream.locked).toBe(false);
  });

  it("cancels as soon as actual bytes exceed the limit without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new Uint8Array(2)); c.enqueue(new Uint8Array(2));
    }, cancel });
    await expect(readBoundedBody(stream, 3, signal())).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("interrupts a stalled read on cancellation", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const result = readBoundedBody(stream, 3, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("handles already-aborted signals, null bodies, and stream failures", async () => {
    const aborted = AbortSignal.abort();
    await expect(readBoundedBody(null, 3, aborted)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readBoundedBody(null, 3, signal())).resolves.toHaveLength(0);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("broken connection")); } });
    await expect(readBoundedBody(stream, 3, signal())).rejects.toThrow("broken connection");
    expect(stream.locked).toBe(false);
  });
});
