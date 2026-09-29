import { NextResponse } from "next/server";
import { HttpStdbTransport } from "@/src/lib/api-endpoint";

/**
 * Bearer gate for the blob routes (`/api/upload/*`).
 *
 * The client sends its own SpacetimeDB identity token:
 *   Authorization: Bearer <stdb-token>
 * The token is validated by *exercising* it — the `authorize_blob_access`
 * reducer runs `require_page_write`/`require_page_read` as the caller, so
 * page ACLs are enforced with the caller's own identity. Any failure
 * (bad token, no access, DB unreachable) becomes 401/403 without leaking
 * details.
 */

function stdbBaseUrl(): string {
  return (
    process.env.SPACETIMEDB_INTERNAL_URL?.trim() || "http://spacetimedb:3000"
  );
}

export function isValidDbName(db: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(db);
}

/** Extract the page id from a `pages/{pageId}/{uuid}.ext` storage key. */
export function pageIdFromKey(key: string): number | null {
  const m = /^pages\/(\d+)\//.exec(key);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Authorize a blob operation. Returns `null` when allowed, otherwise a
 * `NextResponse` (401/403/503) to return directly.
 */
export async function authorizeBlobRequest(
  request: Request,
  dbName: string,
  pageId: number,
  write: boolean,
): Promise<NextResponse | null> {
  if (!isValidDbName(dbName)) {
    return NextResponse.json({ error: "Invalid db" }, { status: 400 });
  }
  const auth = request.headers.get("authorization");
  const token =
    auth?.startsWith("Bearer ") && auth.length > 7 ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }
  try {
    const transport = new HttpStdbTransport({
      baseUrl: stdbBaseUrl(),
      dbName,
      token,
    });
    await transport.call("authorize_blob_access", [pageId, write]);
    return null;
  } catch (err) {
    console.error("[upload] blob auth denied:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
