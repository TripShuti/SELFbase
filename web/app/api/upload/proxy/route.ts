import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getS3Bucket, isS3Configured } from "@/src/lib/s3";
import { authorizeBlobRequest, pageIdFromKey } from "../_auth";

/**
 * GET /api/upload/proxy?db=<dbName>&key=<storageKey> + Bearer stdb token.
 * Streams the file from S3 so it can be used where a stable, non-expiring
 * URL is needed. Requires page *read* access as the caller.
 */
export async function GET(request: NextRequest) {
  if (!isS3Configured()) {
    return new NextResponse("Upload not configured", { status: 503 });
  }

  const key = request.nextUrl.searchParams.get("key");
  const dbName = request.nextUrl.searchParams.get("db") ?? "";
  if (!key || !key.startsWith("pages/")) {
    return new NextResponse("Missing or invalid key", { status: 400 });
  }
  const pageId = pageIdFromKey(key);
  if (pageId === null) {
    return new NextResponse("Invalid storage key", { status: 400 });
  }

  const denied = await authorizeBlobRequest(request, dbName, pageId, false);
  if (denied) return denied;

  const client = getS3Client();
  const bucket = getS3Bucket();

  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    if (!response.Body) {
      return new NextResponse("Not found", { status: 404 });
    }

    const contentType = response.ContentType ?? "application/octet-stream";
    const contentLength = response.ContentLength;

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    if (contentLength != null) headers.set("Content-Length", String(contentLength));
    // Cache in browser for 1 hour; revalidate via API
    headers.set("Cache-Control", "private, max-age=3600");

    return new NextResponse(response.Body as ReadableStream, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error("[upload/proxy] get error:", err);
    return new NextResponse("Not found", { status: 404 });
  }
}
