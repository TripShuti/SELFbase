"use client";

/**
 * Bootstrap the active workspace from URL query params:
 *   ?ws=ws://127.0.0.1:3300&db=selfbase-local&wsname=Local%20workspace
 *
 * Handy for deep links into any self-hosted instance. Runs SYNCHRONOUSLY
 * during render — before any provider's mount effect reads localStorage —
 * via `ensureSharedWorkspaceActive`. Idempotent, so the render-phase call
 * is safe under StrictMode double-render.
 */

import { ensureSharedWorkspaceActive } from "@/src/lib/workspaceConnections";

let applied = false;

export function WorkspaceQueryBootstrap() {
  if (typeof window !== "undefined" && !applied) {
    applied = true;
    const params = new URLSearchParams(window.location.search);
    const ws = params.get("ws");
    const db = params.get("db");
    if (ws && db) {
      ensureSharedWorkspaceActive({
        name: params.get("wsname") ?? undefined,
        wsUri: ws,
        dbName: db,
      });
    }
  }
  return null;
}
