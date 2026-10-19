/** Platform-neutral stream reader: limits actual bytes, even without Content-Length. */
export class BodyTooLargeError extends Error {
  constructor() { super("Body exceeds size limit"); this.name = "BodyTooLargeError"; }
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) {
    signal.throwIfAborted();
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const chunk = await Promise.race([aborted, reader.read()]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new BodyTooLargeError();
      chunks.push(chunk.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    // A misbehaving underlying source may never resolve cancel().
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
