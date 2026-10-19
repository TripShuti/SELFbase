import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Pure library and hook-helper tests run in Node. Browser lifecycle cases
// are exercised by packages/pulp/tests/autosave-browser.mjs.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
