import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getS3Bucket, isS3Configured } from "@/src/lib/s3";
import { readBoundedBody, BodyTooLargeError } from "@/src/lib/read-bounded-body";
import { authorizeBlobRequest, pageIdFromKey } from "../_auth";

/** Server-side cap for proxied uploads (bytes). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Total deadline includes receiving the file and forwarding it to storage. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * PUT /api/upload/put?db=<dbName>&key=<storageKey> + Bearer stdb token.
 * Proxied upload: the browser PUTs bytes here, the server forwards them to
 * S3. Exists because browsers cannot PUT presigned URLs directly — S3
 * backends (Garage) reject the CORS preflight. Requires page *write*
 * access as the caller (page id parsed from the key).
 */
export async function PUT(request: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Upload is not configured. Set S3_* environment variables." },
      { status: 503 }
    );
  }

  const key = request.nextUrl.searchParams.get("key");
  const dbName = request.nextUrl.searchParams.get("db") ?? "";
  if (!key || !key.startsWith("pages/")) {
    return NextResponse.json({ error: "Missing or invalid key" }, { status: 400 });
  }
  const pageId = pageIdFromKey(key);
  if (pageId === null) {
    return NextResponse.json({ error: "Invalid storage key" }, { status: 400 });
  }

  const denied = await authorizeBlobRequest(request, dbName, pageId, true);
  if (denied) return denied;

  const contentType = request.headers.get("content-type")?.trim() || "application/octet-stream";
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)))) {
    return NextResponse.json({ error: "Invalid Content-Length" }, { status: 400 });
  }
  const declared = Number(lengthHeader ?? 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]);
  let body: Uint8Array;
  try {
    body = await readBoundedBody(request.body, MAX_UPLOAD_BYTES, signal);
  } catch (error) {
    const status = error instanceof BodyTooLargeError ? 413 : signal.aborted ? 408 : 400;
    return NextResponse.json({ error: status === 413 ? "File too large" : status === 408 ? "Upload interrupted or timed out" : "Failed to read upload body" }, { status });
  }
  if (body.byteLength === 0) {
    return NextResponse.json({ error: "Invalid upload body" }, { status: 400 });
  }

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: key,
        ContentType: contentType,
        Body: body,
      }),
      { abortSignal: signal }
    );
  } catch (err) {
    if (signal.aborted) return NextResponse.json({ error: "Upload interrupted or timed out" }, { status: 408 });
    console.error("[upload/put] put error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  return NextResponse.json({ storageKey: key, byteSize: body.byteLength });
}
