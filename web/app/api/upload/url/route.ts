import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  getS3Bucket,
  getS3PresigningClient,
  isS3Configured,
  derivePublicS3EndpointFromRequest,
} from "@/src/lib/s3";
import { authorizeBlobRequest, pageIdFromKey } from "../_auth";

/**
 * GET /api/upload/url?db=<dbName>&key=<storageKey> + Bearer stdb token.
 * Returns a temporary presigned GET URL (1 hour).
 * Requires page *read* access as the caller (page id parsed from the key).
 */
export async function GET(request: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Upload is not configured. Set S3_* environment variables." },
      { status: 503 }
    );
  }

  const key = request.nextUrl.searchParams.get("key");
  const dbName = request.nextUrl.searchParams.get("db") ?? "";
  if (!key || !key.startsWith("pages/")) {
    return NextResponse.json(
      { error: "Query parameter 'key' (storage key) is required and must start with pages/" },
      { status: 400 }
    );
  }
  const pageId = pageIdFromKey(key);
  if (pageId === null) {
    return NextResponse.json({ error: "Invalid storage key" }, { status: 400 });
  }

  const denied = await authorizeBlobRequest(request, dbName, pageId, false);
  if (denied) return denied;

  const bucket = getS3Bucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  let getUrl: string;
  try {
    // Presign against the browser-reachable endpoint, not the internal one.
    const presigningClient = getS3PresigningClient(
      derivePublicS3EndpointFromRequest(request)
    );
    getUrl = await getSignedUrl(presigningClient, command, { expiresIn: 3600 }); // 1 hour
  } catch (err) {
    console.error("[upload/url] presign error:", err);
    return NextResponse.json(
      { error: "Failed to generate download URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({ getUrl });
}
