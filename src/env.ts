/** Worker bindings, vars (wrangler.jsonc) and secrets (wrangler secret put / .dev.vars). */
export interface Env {
  /** D1 database "split-bot". */
  DB: D1Database;

  // vars
  WEBAPP_URL: string;
  /** Comma separated list of allowed CORS origins (localhost / 127.0.0.1 are always allowed). */
  ALLOWED_ORIGINS: string;
  /** Integer days between debt reminders, as a string. */
  REMIND_EVERY_DAYS: string;
  /** Optional: bot username without "@". If absent, the bot layer supplies it via Deps.botUsername. */
  BOT_USERNAME?: string;

  // secrets
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_SECRET: string;
}
