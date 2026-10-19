import { afterEach, expect, test, vi } from "vitest";
import { serveEndpointRequest } from "../../../app/api/e/_shared";

afterEach(() => vi.unstubAllEnvs());

test.each(["POST", "PATCH"])("%s oversized bodies return JSON 413", async (method) => {
  vi.stubEnv("SELFBASE_STDB_TOKEN", "test-service-token");
  vi.stubEnv("NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE", "");
  const request = new Request("http://localhost/api/e/records", {
    method, body: "x".repeat(1_048_577),
  });
  const response = await serveEndpointRequest({ request, slug: "records" });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
});

test("malformed JSON returns JSON 400", async () => {
  vi.stubEnv("SELFBASE_STDB_TOKEN", "test-service-token");
  vi.stubEnv("NEXT_PUBLIC_SELFBASE_API_URL_TEMPLATE", "");
  const response = await serveEndpointRequest({ slug: "records", request:
    new Request("http://localhost/api/e/records", { method: "POST", body: "{" }) });
  expect(response.status).toBe(400);
});
