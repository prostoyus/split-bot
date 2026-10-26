import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Keep in sync with test/helpers.ts.
const TEST_BOT_TOKEN = "123456:TEST-token-for-vitest";

// Never let wrangler load real secrets from .env / .dev.vars into tests.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

export default defineConfig(async () => {
  // Read in Node.js, applied inside workerd by test/setup.ts.
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: TEST_BOT_TOKEN,
            BOT_USERNAME: "split_test_bot",
            WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef",
            ADMIN_SECRET: "test-admin-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
