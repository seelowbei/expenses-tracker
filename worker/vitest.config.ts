import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd. No wrangler config: unit tests use fakes, never the real AI binding.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-11-01", // keep in sync with wrangler.jsonc
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      // workerd has no V8 coverage support; Istanbul instruments the code instead.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
