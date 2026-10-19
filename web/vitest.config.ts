import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Scoped to the shared platform-agnostic libs for now — the app itself is
// exercised by Next's own tooling. (`src/hooks/useSyncChildPageLinks.test.ts`
// predates this config and needs a jsdom environment + fixture work before
// it can join the include list.)
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
