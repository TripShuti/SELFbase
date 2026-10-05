"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import {
  readActiveWorkspaceToken,
  tokenStorageKey,
} from "@/src/lib/workspaceConnections";

/**
 * Standalone blob upload/download against the local `/api/upload/*` routes.
 *
 * Upload dance:
 *   1. POST /api/upload/request { dbName, pageId, filename, contentType }
 *      (+ Bearer stdb token) → { uploadUrl, storageKey }
 *   2. PUT <uploadUrl> → actual bytes (client → S3)
 *
 * The returned `storageKey` (`pages/{pageId}/{uuid}.ext`) is stored on the
 * component props / property value. Display URLs are resolved through
 * {@link useBlobSrc}, which mints a short-lived presigned GET via
 * `/api/upload/url` (same Bearer gate) — plain `<img src>` tags cannot send
 * Authorization headers, so the presigned URL is fetched first.
 */

export type UploadWorkspaceBlobParams = {
  /** Database name of the active workspace (standalone slug). */
  slug: string;
  /** The raw file/blob to upload. */
  body: Blob;
  /** MIME type to store alongside the object. */
  contentType: string;
  pageId?: bigint;
};

export type UploadWorkspaceBlobResult = {
  objectId: string;
  byteSize: number;
  /** Full S3 key (`pages/{pageId}/{uuid}.ext`). */
  storageKey?: string;
};

/** The active workspace's SpacetimeDB identity token (if signed in). */
export function useWorkspaceToken(): string | null {
  const { activeWorkspace } = useWorkspace();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!activeWorkspace) {
      setToken(null);
      return;
    }
    try {
      setToken(localStorage.getItem(tokenStorageKey(activeWorkspace.id)));
    } catch {
      setToken(null);
    }
  }, [activeWorkspace]);
  return token;
}

function readWorkspaceToken(): string | null {
  return readActiveWorkspaceToken();
}

async function jsonOr<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Full upload dance: presign → PUT. Returns storage info on success,
 * null on any failure (already logged).
 */
export async function uploadWorkspaceBlob(
  params: UploadWorkspaceBlobParams
): Promise<UploadWorkspaceBlobResult | null> {
  const { slug: dbName, body, contentType } = params;
  if (!dbName) {
    console.error("[blobUpload] missing workspace db name");
    return null;
  }
  if (params.pageId === undefined) {
    console.error("[blobUpload] missing pageId");
    return null;
  }
  const token = readWorkspaceToken();
  if (!token) {
    console.error("[blobUpload] not signed in");
    return null;
  }

  const presignRes = await fetch("/api/upload/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dbName,
      pageId: params.pageId.toString(),
      filename: (body as File).name ?? "upload.bin",
      contentType,
    }),
  });
  if (!presignRes.ok) {
    const err = await jsonOr<{ error?: string }>(presignRes);
    console.error("[blobUpload] presign failed", presignRes.status, err);
    return null;
  }
  const presign = (await presignRes.json()) as {
    uploadUrl: string;
    storageKey: string;
  };

  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": contentType,
      // Same-origin PUT proxy requires the workspace token.
      Authorization: `Bearer ${token}`,
    },
  });
  if (!putRes.ok) {
    console.error("[blobUpload] PUT failed", putRes.status, await putRes.text().catch(() => ""));
    return null;
  }

  return {
    objectId: presign.storageKey,
    byteSize: body.size,
    storageKey: presign.storageKey,
  };
}

/**
 * Resolve a display URL for a stored blob.
 *
 * - `pages/{pageId}/…` keys (this fork's uploads): mint a short-lived
 *   presigned GET through `/api/upload/url` with the workspace token.
 * - Anything else (absolute http(s) URLs): returned as-is.
 * - Empty/unknown: "" while loading or unresolvable.
 */
export function useBlobSrc(
  storageKey: string | undefined | null,
  dbName: string | undefined | null
): string {
  const token = useWorkspaceToken();
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!storageKey) {
      setSrc("");
      return;
    }
    if (/^https?:\/\//i.test(storageKey)) {
      setSrc(storageKey);
      return;
    }
    if (!storageKey.startsWith("pages/") || !dbName || !token) {
      setSrc("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/upload/url?db=${encodeURIComponent(dbName)}&key=${encodeURIComponent(storageKey)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { getUrl?: string };
        if (!cancelled) setSrc(data.getUrl ?? "");
      } catch (err) {
        console.error("[blobUpload] resolve failed", err);
        if (!cancelled) setSrc("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storageKey, dbName, token]);
  return src;
}

/**
 * Download URL variant — same presigned-GET resolution as {@link useBlobSrc}.
 * (The presigned URL honors the stored content type; for `download` with the
 * original filename use `workspaceBlobDownloadHref`.)
 */
export function useBlobDownloadHref(
  storageKey: string | undefined | null,
  dbName: string | undefined | null
): string {
  return useBlobSrc(storageKey, dbName);
}

/**
 * Legacy cloud helpers below are intentionally inert in this fork: standalone
 * workspaces have no `/api/workspaces/{slug}/blobs/*` routes. They are kept
 * so old call sites keep compiling while being migrated to {@link useBlobSrc}.
 */

/** @deprecated Use {@link useBlobSrc} instead. */
export function workspaceBlobSrc(_slug: string, _storageKey: string): string {
  return "";
}

/** @deprecated Use {@link useBlobDownloadHref} instead. */
export function workspaceBlobDownloadHref(
  _slug: string,
  _storageKey: string,
  _filename: string
): string {
  return "";
}

/**
 * Resolve the current workspace slug for blob URLs.
 *
 * Priority:
 *   1. URL param `slug` (Next.js route like `/workspace/[slug]/…`).
 *   2. `activeWorkspace.dbName` from the WorkspaceProvider (localStorage-
 *      backed). This is the fallback for standalone workspaces where there
 *      is no slug-based URL.
 */
export function useWorkspaceSlug(): string {
  const params = useParams() as { slug?: string | string[] } | null;
  const rawSlug = params?.slug;
  const urlSlug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
  const { activeWorkspace } = useWorkspace();
  return (urlSlug ?? activeWorkspace?.dbName ?? "").trim();
}
