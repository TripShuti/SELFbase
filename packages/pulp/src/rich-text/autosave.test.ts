import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave } from "./autosave";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("document autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a rejected save without another edit", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = new Autosave({ save, canSave: () => true, onError });
    queue.changed();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(2);
    queue.stop();
  });

  it("serializes snapshots and preserves edits made during a request", async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = new Autosave({ save, canSave: () => true, onError: vi.fn() });
    queue.changed();
    const flushing = queue.flush();
    queue.changed();
    await queue.flush();
    expect(save).toHaveBeenCalledOnce();
    first.resolve();
    await flushing;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).toHaveBeenCalledTimes(2);
    queue.stop();
  });

  it("retains pending changes while disconnected and flushes on reconnect", async () => {
    let connected = false;
    const save = vi.fn();
    const queue = new Autosave({ save, canSave: () => connected, onError: vi.fn() });
    queue.changed();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).not.toHaveBeenCalled();
    connected = true;
    await queue.flush();
    expect(save).toHaveBeenCalledOnce();
    queue.stop();
  });

  it("handles synchronous failures and stops retries after disposal", async () => {
    const save = vi.fn(() => { throw new Error("transport closed"); });
    const queue = new Autosave({ save, canSave: () => true, onError: vi.fn() });
    queue.changed();
    await queue.flush();
    queue.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save a deleted or suppressed block", async () => {
    const save = vi.fn();
    const queue = new Autosave({ save, canSave: () => false, onError: vi.fn() });
    queue.changed();
    await queue.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).not.toHaveBeenCalled();
    queue.stop();
  });

  it("does not restart a disposed queue when an in-flight save fails", async () => {
    const request = deferred();
    const save = vi.fn(() => request.promise);
    const queue = new Autosave({ save, canSave: () => true, onError: vi.fn() });
    queue.changed();
    const flushing = queue.flush();
    queue.stop();
    request.reject(new Error("closed"));
    await flushing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledOnce();
  });
  it("reconnects with an unresolved old reducer and ignores its late acknowledgement", async () => {
    const old = deferred();
    const current = deferred();
    const save = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue(undefined);
    const queue = new Autosave({ save, canSave: () => true, onError: vi.fn() });
    queue.changed();
    const staleFlush = queue.flush();
    queue.disconnected();
    queue.changed();
    const reconnectedFlush = queue.flush();
    expect(save).toHaveBeenCalledTimes(2);
    old.resolve();
    await staleFlush;
    queue.changed();
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(2);
    current.resolve();
    await reconnectedFlush;
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(3);
    queue.stop();
  });

});
