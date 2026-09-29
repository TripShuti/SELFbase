import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  getS3PresigningClient,
  getS3Bucket,
  isS3Configured,
  derivePublicS3EndpointFromRequest,
} from "@/src/lib/s3";
import { authorizeBlobRequest } from "../_auth";

/** Sanitize filename to a safe extension (e.g. ".png") or default. */
function getExtension(filename: string): string {
  const last = filename.split("/").pop() ?? "";
  const idx = last.lastIndexOf(".");
  if (idx <= 0) return "";
  const ext = last.slice(idx).toLowerCase();
  if (/^\.([a-z0-9]+)$/.test(ext)) return ext;
  return "";
}

function isSaneContentType(ct: string): boolean {
  return ct.length > 0 && ct.length <= 128 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(ct);
}

/**
 * POST /api/upload/request — presigned PUT for a page attachment.
 * Body: { dbName, pageId, filename, contentType } + Bearer stdb token.
 * Requires page *write* access as the caller.
 */
export async function POST(request: Request) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Upload is not configured. Set S3_* environment variables." },
      { status: 503 }
    );
  }

  let body: { dbName?: string; pageId?: string; filename?: string; contentType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const dbName = typeof body.dbName === "string" ? body.dbName.trim() : "";
  const pageIdRaw = typeof body.pageId === "string" ? body.pageId.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "application/octet-stream";

  if (!dbName || !pageIdRaw || !filename) {
    return NextResponse.json(
      { error: "dbName, pageId and filename are required" },
      { status: 400 }
    );
  }
  if (!/^\d+$/.test(pageIdRaw)) {
    return NextResponse.json({ error: "Invalid pageId" }, { status: 400 });
  }
  if (!isSaneContentType(contentType)) {
    return NextResponse.json({ error: "Invalid contentType" }, { status: 400 });
  }
  const pageId = Number(pageIdRaw);
  if (!Number.isSafeInteger(pageId)) {
    return NextResponse.json({ error: "Invalid pageId" }, { status: 400 });
  }

  const denied = await authorizeBlobRequest(request, dbName, pageId, true);
  if (denied) return denied;

  const ext = getExtension(filename) || ".bin";
  const storageKey = `pages/${pageId}/${crypto.randomUUID()}${ext}`;
  const bucket = getS3Bucket();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ContentType: contentType,
  });

  const publicEndpoint = derivePublicS3EndpointFromRequest(request);

  let uploadUrl: string;
  try {
    const presigningClient = getS3PresigningClient(publicEndpoint);
    uploadUrl = await getSignedUrl(presigningClient, command, { expiresIn: 900 }); // 15 min
  } catch (err) {
    console.error("[upload/request] presign error:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({ uploadUrl, storageKey });
}
