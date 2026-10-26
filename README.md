# Split Bot — "Who owes whom"

Telegram bot + Mini App for splitting shared expenses (trips, parties, shared flats).
Runs 24/7 on the Cloudflare free plan.

- Create an event and invite friends with a link
- Add expenses: who paid, how much, split equally or with custom amounts per person
- See balances and the minimal list of transfers ("who owes whom")
- Mark a debt as returned — the recipient confirms it
- Notifications and periodic reminders to debtors

## How it works

```
GitHub Pages (static)                       Cloudflare (free plan)
https://prostoyus.github.io/split-bot/      ┌──────────────────────────────────────────┐
  webapp/  ── fetch() ─────────────────►    │ Worker "split-bot" (TypeScript)          │
                                            │   /api/*        REST API (Hono)          │
Telegram  ── webhook ──────────────────►    │   /tg/webhook   bot (grammY)             │
                                            │   /admin/setup  one-time Telegram setup  │
                                            │   cron hourly   debt reminders           │
                                            │ D1 database (SQLite)                     │
                                            └──────────────────────────────────────────┘
```

- `webapp/` — the Mini App (plain HTML/CSS/JS), served by GitHub Pages. API address is in `webapp/config.js`.
- `src/core/` — business logic (money math, splits, balances, settlements).
- `src/api/` — REST API and Telegram `initData` authentication.
- `src/bot/` — bot commands, notifications, reminders, webhook setup.
- `migrations/` — D1 database schema.

See [SPEC.md](SPEC.md) for the full technical spec. The first version (Python + local tunnel) is kept in the
git tag [`v1-python`](https://github.com/prostoyus/split-bot/tree/v1-python).

## Deploy your own copy

Requires Node.js 22+ and a free Cloudflare account. On Windows PowerShell use `npx.cmd` instead of `npx`
if script execution is disabled.

1. Create a bot in [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Install dependencies and log in to Cloudflare:

   ```
   npm ci
   npx wrangler login
   ```

3. Create the database and put its id into `wrangler.jsonc` (`database_id`), then create the tables:

   ```
   npx wrangler d1 create split-bot
   npm run db:migrate:remote
   ```

4. In `wrangler.jsonc` set `WEBAPP_URL`, `ALLOWED_ORIGINS` (your GitHub Pages origin) and `BOT_USERNAME`.
5. Deploy and set the secrets (`WEBHOOK_SECRET` and `ADMIN_SECRET` are any long random strings):

   ```
   npx wrangler deploy
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put ADMIN_SECRET
   ```

6. Connect the bot to the Worker (sets the webhook, commands and the menu button):

   ```
   curl -X POST https://<your-worker>.workers.dev/admin/setup -H "Authorization: Bearer <ADMIN_SECRET>"
   ```

7. Put your Worker URL into `webapp/config.js` (`apiBase`), enable GitHub Pages for the repo
   (Settings → Pages → branch `main`, folder `/`), and open your bot in Telegram.

## Development

```
npm test            # vitest in the real Workers runtime with a local D1
npm run typecheck
npm run dev         # local Worker; copy .dev.vars.example to .dev.vars first
```

The Mini App can be pointed at a local Worker with `?api=http://127.0.0.1:8787`.

## Security notes

- Secrets live only in Cloudflare (`wrangler secret`) or in the gitignored `.dev.vars`.
- Every API request is authenticated by validating Telegram `initData` (HMAC with the bot token, max age 24h).
- The webhook accepts only requests carrying Telegram's secret token header; `/admin/setup` requires a bearer secret.
- The Mini App talks only to the API address in `config.js` and has a strict Content-Security-Policy.
