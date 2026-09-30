import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic and the UserSession Durable Object (with a fake
// storage). Plain Node: `cloudflare:workers` is swapped for a tiny stub so the
// DO class can be constructed outside workerd. End-to-end checks run against
// `wrangler dev` and a throwaway Neon branch, not here.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./worker/testing/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    include: ["{worker,src,scripts}/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
