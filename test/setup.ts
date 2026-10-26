import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Idempotent: already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every test starts from an empty database.
beforeEach(async () => {
  await env.DB.batch(
    ["reminders", "settlements", "expense_shares", "expenses", "members", "events", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
