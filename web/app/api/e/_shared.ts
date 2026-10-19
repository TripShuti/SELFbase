/**
 * Wiring for the default SELFbase Next.js custom-API handler. Reads
 * `SELFBASE_STDB_*` env vars,
 * validates the request's Bearer key, and self-disables when an external
 * gateway is configured via `NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE`.
 *
 * All HTTP-method routes ([slug]/route.ts, [slug]/[id]/route.ts,
 * [slug]/_schema/route.ts) defer to `serveEndpointRequest()` here.
 */

import {
  ApiEndpointError,
  type AuthResult,
  EndpointConfigCache,
  HttpStdbTransport,
  dispatchApiEndpointRequest,
  isCustomTemplate,
  parseAllowedMethods,
  resolveEndpointUrl,
  unwrapScalar,
  type StdbTransport,
} from "@/src/lib/api-endpoint";
import { BodyTooLargeError, readBoundedBody } from "@/src/lib/read-bounded-body";

/** Upper bound for a custom-API JSON body, applied even without Content-Length. */
const MAX_REQUEST_BODY_BYTES = 1_048_576;

const SHARED_CACHE = new EndpointConfigCache({ maxEntries: 256, ttlMs: 60_000 });

let cachedTransport: StdbTransport | null = null;

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function getConfiguredDbName(): string {
  return env("SELFBASE_STDB_DB_NAME") || "selfbase";
}

function getTransport(): StdbTransport {
  if (cachedTransport) return cachedTransport;
  const baseUrl = env("SELFBASE_STDB_URL") || "http://localhost:3000";
  const dbName = getConfiguredDbName();
  const token = env("SELFBASE_STDB_TOKEN");
  if (!token) {
    throw new ApiEndpointError(
      503,
      "stdb_not_configured",
      "SELFBASE_STDB_TOKEN is not set. Set it in your environment so the API handler can authenticate to SpacetimeDB.",
    );
  }
  cachedTransport = new HttpStdbTransport({ baseUrl, dbName, token, timeoutMs: 15_000 });
  return cachedTransport;
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ApiKeyRow {
  id: string | number;
  endpoint_id: string | number;
  allowed_methods: unknown;
  expires_at: unknown;
}

async function authenticateRequest(
  request: Request,
  endpointSlug: string,
  method: string,
  transport: StdbTransport,
): Promise<AuthResult> {
  const header = request.headers.get("authorization");
  if (header && /^bearer\s+/i.test(header)) {
    const raw = header.replace(/^bearer\s+/i, "").trim();
    if (!raw) {
      throw new ApiEndpointError(401, "auth_invalid", "Bearer token is empty");
    }
    const hash = await sha256Hex(raw);
    const safeHash = hash.replace(/'/g, "''");
    const safeSlug = endpointSlug.replace(/'/g, "''");

    // Query the public `api_endpoint_key_lookup` view — a narrow projection
    // of the private `api_endpoint_key` table — so non-owner identities can
    // validate Bearer tokens. The default Next.js handler uses the database
    // owner token and could read the private table directly, but we go
    // through the view in both runtimes for a single auth code path.
    const rows = await transport.sql<ApiKeyRow>(
      `SELECT k.id, k.endpoint_id, k.allowed_methods, k.expires_at
         FROM api_endpoint_key_lookup k
         JOIN api_endpoint e ON e.id = k.endpoint_id
        WHERE e.slug = '${safeSlug}'
          AND k.key_hash = '${safeHash}'
        LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new ApiEndpointError(401, "auth_invalid", "Invalid API key");
    }
    const key = rows[0];

    // Expiry check. STDB's `/sql` returns `Option<Timestamp>` positionally as
    // `[0, [micros]]` (Some) / `[1, []]` (None) — `unwrapScalar` normalises both
    // that and the older `{some:{…}}`/`{none:[]}` object form. Comparing only
    // the object form (as this code used to) left every positional-shape key
    // valid forever.
    const expiresMicros = unwrapScalar(key.expires_at);
    if (expiresMicros != null) {
      const micros =
        typeof expiresMicros === "string" ? Number(expiresMicros) : expiresMicros;
      const expiresMs = micros / 1000;
      if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        throw new ApiEndpointError(401, "auth_invalid", "API key has expired");
      }
    }

    if (!(parseAllowedMethods(key.allowed_methods) as string[]).includes(method.toUpperCase())) {
      throw new ApiEndpointError(
        403,
        "method_not_allowed_for_key",
        `API key does not permit ${method} requests`,
      );
    }

    return { kind: "api-key", keyId: Number(key.id) };
  }

  // No bearer header. Fall back to "open" — the dispatcher will reject the
  // request when `endpoint.requireAuth` is true. Self-hosted SELFbase can later
  // wire its OIDC session here to elevate to `kind: "session"`.
  return { kind: "open" };
}

interface ServeOptions {
  request: Request;
  slug: string;
  trailing?: string;
}

/**
 * Entry point shared by every method/route file. Returns either the
 * dispatcher's `Response` or a 410-with-`Location` redirect when an
 * external gateway has taken over via `NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE`.
 */
export async function serveEndpointRequest(opts: ServeOptions): Promise<Response> {
  const { request, slug, trailing } = opts;
  const url = new URL(request.url);
  const template = process.env.NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE?.trim();
  if (isCustomTemplate(template)) {
    const target = resolveEndpointUrl({
      template,
      workspaceSlug: "",
      endpointSlug: slug,
      origin: url.origin,
    });
    return new Response(null, {
      status: 410,
      headers: {
        Location: target,
        "Cache-Control": "no-store",
      },
    });
  }

  let transport: StdbTransport;
  try {
    transport = getTransport();
  } catch (e) {
    return errorJson(e);
  }

  let auth: AuthResult;
  try {
    auth = await authenticateRequest(request, slug, request.method, transport);
  } catch (e) {
    return errorJson(e);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return errorJson(error);
  }
  const callerIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    undefined;

  return dispatchApiEndpointRequest({
    url,
    method: request.method,
    body,
    endpointSlug: slug,
    trailing,
    transport,
    auth,
    cache: SHARED_CACHE,
    // This handler owns one process-wide transport configured by SELFBASE_STDB_*.
    // Supplying an explicit namespace opts it into the dispatcher's cache;
    // multi-tenant hosts must use a distinct stable identity per database.
    cacheNamespace: `self-hosted-db:${getConfiguredDbName()}`,
    callerIp: callerIp ?? undefined,
    baseUrl: `${url.origin}/api/e/${encodeURIComponent(slug)}`,
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return undefined;
  let text: string;
  try {
    const bytes = await readBoundedBody(
      request.body,
      MAX_REQUEST_BODY_BYTES,
      request.signal,
    );
    text = new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new ApiEndpointError(
        413,
        "payload_too_large",
        "Request body exceeds the 1 MiB limit",
      );
    }
    throw err;
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiEndpointError(
      400,
      "invalid_body",
      "Request body must be valid JSON",
    );
  }
}

function errorJson(err: unknown): Response {
  if (err instanceof ApiEndpointError) {
    return new Response(
      JSON.stringify({
        error: { code: err.code, message: err.message, details: err.details },
      }),
      {
        status: err.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Response(
    JSON.stringify({ error: { code: "internal_error", message } }),
    {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}
