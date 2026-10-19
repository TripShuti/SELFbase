import { afterEach, expect, test, vi } from "vitest";
import { isTrustedWorkspaceUri } from "./workspaceConnections";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("deep links trust only the current, configured, and explicitly allowed hosts", () => {
  vi.stubGlobal("window", { location: { host: "app.example" } });
  vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_URI", "wss://db.example");
  vi.stubEnv("NEXT_PUBLIC_ALLOWED_WORKSPACE_HOSTS", "extra.example:3000, second.example");
  expect(isTrustedWorkspaceUri("wss://app.example")).toBe(true);
  expect(isTrustedWorkspaceUri("wss://db.example")).toBe(true);
  expect(isTrustedWorkspaceUri("ws://extra.example:3000")).toBe(true);
  expect(isTrustedWorkspaceUri("wss://second.example")).toBe(true);
  expect(isTrustedWorkspaceUri("wss://app.example.attacker.test")).toBe(false);
  expect(isTrustedWorkspaceUri("wss://app.example@attacker.test")).toBe(false);
  expect(isTrustedWorkspaceUri("ws://extra.example:3001")).toBe(false);
});
