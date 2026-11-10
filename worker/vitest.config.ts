import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd. No wrangler config: unit tests use fakes, never the real AI binding
// or Google. D1 is a local Miniflare database with the real migrations applied (test/setup.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-11-01", // keep in sync with wrangler.jsonc
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: "http://localhost:8787",
            DEFAULT_CURRENCY: "SGD",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // 32 zero bytes / 32 0x01 bytes, base64. Test-only keys.
            TOKEN_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            SESSION_SECRET: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            ALLOWED_EMAILS: "alice@example.com, Bob@Example.com",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      coverage: {
        // workerd has no V8 coverage support; Istanbul instruments the code instead.
        provider: "istanbul",
        include: ["src/**/*.ts"],
        reporter: ["text", "html", "lcov"],
        reportsDirectory: "coverage",
      },
    },
  };
});
