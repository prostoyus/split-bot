# Split Bot ("Who owes whom") — technical spec (v2, Cloudflare Workers)

Telegram bot + Mini App for splitting shared expenses (trips, parties, flats).
Single source of truth for all agents. Do not change contracts here without updating this file.
v1 (Python, aiogram, cloudflared tunnel) is preserved in git tag `v1-python` — use it as the reference
implementation for business rules, texts and edge cases (`git show v1-python:app/services.py` etc.).

## Runtime architecture

```
GitHub Pages (static)                       Cloudflare (free plan)
https://prostoyus.github.io/split-bot/      ┌───────────────────────────────────────────────┐
  webapp/  ── fetch() ───────────────────►  │ Worker "split-bot" (TypeScript)               │
                                            │   fetch:  /api/*        Hono REST API          │
Telegram  ── webhook POST ──────────────►   │           /tg/webhook   grammY bot             │
                                            │           /admin/setup  one-time Telegram setup │
                                            │   scheduled (cron, hourly): debt reminders     │
                                            │ D1 database "split-bot" (SQLite)               │
                                            └───────────────────────────────────────────────┘
```

- Public URL: `https://split-bot.<account-subdomain>.workers.dev` (known after first deploy).
- Always on, no sleeping. Free plan limits that shape the design (verify current values in Cloudflare docs):
  100k requests/day, **10 ms CPU per invocation**, limited subrequests per invocation, 5 cron triggers.
  Keep handlers light: no heavy libs, WebCrypto for HMAC, few D1 round-trips (use `db.batch` where natural).

## Tech

- Node.js 24 LTS (installed), npm. TypeScript, ES modules. Deps already installed in `package.json`:
  `hono`, `grammy`; dev: `wrangler` 4, `typescript`, `vitest` 4, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`.
  Do not add other runtime deps without a strong reason (state it in your report).
- Tests: vitest with `@cloudflare/vitest-pool-workers` (real workerd + local D1, migrations applied in tests).
- Frontend: plain HTML/CSS/JS in `webapp/`, no build step, served by GitHub Pages.
- Code, comments, commits in English. User-facing texts in Russian (reuse v1 texts).
- PowerShell note for agents: refresh PATH first so node/npm are found:
  `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`

## Config

`wrangler.jsonc` (committed): worker name `split-bot`, `main: src/index.ts`, compatibility date, D1 binding `DB`
(database `split-bot`; `database_id` placeholder until the real DB is created at deploy), cron `0 * * * *`, vars:

```
WEBAPP_URL = "https://prostoyus.github.io/split-bot/webapp/"
ALLOWED_ORIGINS = "https://prostoyus.github.io"   # comma separated; http://localhost:* and http://127.0.0.1:* always allowed
REMIND_EVERY_DAYS = "3"
```

Secrets (never committed; `wrangler secret put` in prod, `.dev.vars` locally — gitignored):

```
BOT_TOKEN        # from @BotFather
WEBHOOK_SECRET   # random 32+ chars; sent by Telegram in X-Telegram-Bot-Api-Secret-Token
ADMIN_SECRET     # random 32+ chars; protects /admin/setup
```

`.dev.vars.example` (committed) lists the names with empty values.

## Project layout and ownership

```
src/
  index.ts            # Worker entry: export default { fetch, scheduled }   (telegram-bot-dev; composes everything)
  env.ts              # Env interface (bindings, vars, secrets)              (backend-architect)
  core/               # backend-architect — pure business logic, no Telegram imports
    db.ts             # D1 helpers, row mapping
    money.ts          # formatMoney(amount, currency) — "1 500,50 ₽", hide ",00"
    split.ts          # splitEqually, validateExactShares, minimizeTransfers (pure)
    services.ts       # all use cases (see below)
    notify.ts         # Notifier type + helpers
    errors.ts         # ServiceError(status, message) + subclasses
  api/                # backend-architect
    app.ts            # createApi(): Hono app mounted at /api, CORS, error handling
    auth.ts           # Telegram initData validation (WebCrypto)
  bot/                # telegram-bot-dev
    bot.ts            # createBot(env, deps) grammY bot (webhook mode, botInfo cached — no getMe per request)
    handlers.ts keyboards.ts texts.ts
    notifier.ts       # Telegram implementation of Notifier
    reminders.ts      # runReminders(env, deps, now)
    setup.ts          # /admin/setup: setWebhook(secret_token, allowed_updates), setMyCommands, setChatMenuButton
migrations/0001_init.sql   # backend-architect
test/                      # vitest; core/api tests by backend-architect, bot tests by telegram-bot-dev
webapp/                    # frontend-developer
wrangler.jsonc vitest.config.ts tsconfig.json package.json .dev.vars.example
```

The Python v1 files (`app/ bot/ tests/ run.py tunnel.py requirements.txt pytest.ini .env.example`) are removed at the
end of the migration by the lead — do not edit them.

## Data model (D1 / SQLite)

Money is stored as **integer minor units** (kopecks). Never floats. Timestamps: INTEGER unix milliseconds (UTC);
API returns ISO 8601 strings with `Z`.

- `users`: `id` (Telegram user id, PK), `first_name`, `last_name`, `username`, `created_at`
- `events`: `id`, `title` (1..64 chars), `currency` (default `RUB`; one of RUB, USD, EUR, KZT, UZS, UAH, BYN, TRY, GEL),
  `invite_code` (random url-safe 10 chars from crypto.getRandomValues, unique), `owner_id`, `created_at`.
  Max **50 events owned per user** (400 "Слишком много событий (максимум 50)"; atomic COUNT inside the INSERT).
- `members`: `event_id`, `user_id`, `joined_at` (PK event_id+user_id). Max **40 members per event**
  (400 "В событии уже максимум участников") — bounds notification fan-out.
- `expenses`: `id`, `event_id`, `payer_id`, `amount` (1..10_000_000_000), `description` (1..100), `split_mode`
  (`equal|exact`), `created_by`, `created_at`. Max **1000 expenses per event**
  (400 "В событии слишком много трат (максимум 1000)"; check-then-insert, may overshoot slightly under concurrency).
- `expense_shares`: `expense_id`, `user_id`, `amount` — shares always sum exactly to `amount` (ON DELETE CASCADE).
  - equal: remainder kopecks go one each to the first participants by user id order.
  - exact: shares given by the client (see Split modes).
- `settlements`: `id`, `event_id`, `from_id`, `to_id`, `amount`, `status` (`pending|confirmed|rejected`),
  `created_at`, `resolved_at`. Partial unique index: one `pending` per (event_id, from_id, to_id).
- `reminders`: `event_id`, `user_id`, `last_sent_at` (PK event_id+user_id)
- Foreign keys and CHECK constraints as in v1. Indexes for event_id lookups.

## Balance rules

- net(user) = sum(paid expenses) − sum(own shares) + sum(confirmed settlements sent) − sum(confirmed settlements received).
  net > 0 → others owe the user; net < 0 → user owes.
- Sum of all nets in an event is always 0.
- "Who owes whom" = greedy minimization: repeatedly match the largest debtor with the largest creditor.
  Deterministic order (tie-break by user id).

## Auth

- Every `/api/*` request (except `GET /api/health`) must send header `X-Telegram-Init-Data: <Telegram.WebApp.initData>`.
- Validate per Telegram docs: secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN); data_check_string = sorted
  `key=value` lines without `hash`; constant-time compare; reject duplicate keys; reject `auth_date` older than 24h
  (allow 5 min clock skew into the future); parse `user` JSON defensively; upsert the user.
- 401 on invalid/missing. 403 if user is not a member of the event. 404 for unknown ids.
- CORS: allow origins from `ALLOWED_ORIGINS` plus `http://localhost:*` / `http://127.0.0.1:*`;
  allow headers `X-Telegram-Init-Data`, `Content-Type`; no credentials.
- `/tg/webhook`: reject (401, no processing) unless header `X-Telegram-Bot-Api-Secret-Token` equals `WEBHOOK_SECRET`
  (constant-time compare).
- `/admin/setup` (POST): requires header `Authorization: Bearer <ADMIN_SECRET>` (constant-time compare), else 401.
  Uses the request's own origin to build the webhook URL `<origin>/tg/webhook`. Returns JSON summary, never secrets.
- Rate limiting: best-effort per-isolate limiter (120 req/min per user → 429 "Слишком много запросов") is enough.

## REST API (JSON, prefix `/api`) — same contract as v1

User object everywhere: `{ "id": int, "name": str, "username": str|null }` (`name` = first + last name).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ "ok": true }` (no auth) |
| GET | `/api/config` | – | `{ "bot_username": str }` |
| GET | `/api/me` | – | user |
| GET | `/api/events` | – | `[{ id, title, currency, members_count, my_net }]` newest first |
| POST | `/api/events` | `{ title, currency? }` | event detail (creator becomes member) |
| GET | `/api/events/{id}` | – | `{ id, title, currency, invite_code, invite_link, owner_id, members:[user], my_net }` — `invite_link` = `https://t.me/<bot_username>?start=join_<invite_code>` |
| PATCH | `/api/events/{id}` | `{ title }` | event detail. Only the owner (403 "Переименовать событие может только его создатель"); title trimmed, 1..64 chars (same validation/messages as create); same title → 200 without notification |
| POST | `/api/join` | `{ invite_code }` | event detail (idempotent) |
| GET | `/api/events/{id}/expenses` | – | `[{ id, payer:user, amount, description, split, created_at, created_by, shares:[{user, amount}] }]` newest first |
| POST | `/api/events/{id}/expenses` | `{ amount, description, payer_id, split?: "equal"\|"exact", participant_ids?:[int], shares?:[{user_id, amount}] }` | expense. See "Split modes" below |
| DELETE | `/api/expenses/{id}` | – | `{ "ok": true }` — only creator or payer |
| GET | `/api/events/{id}/balances` | – | `{ balances:[{ user, net }], transfers:[{ from:user, to:user, amount }] }` |
| GET | `/api/events/{id}/settlements` | – | `[{ id, from:user, to:user, amount, status, created_at }]` newest first |
| POST | `/api/events/{id}/settlements` | `{ to_id, amount }` | settlement (status pending); from = current user; to must be member, != self. `amount` ≤ sender's debt to `to` = amount of the current minimal transfer from→to minus sender's pending settlements to `to` (no such transfer → 400 "Сумма больше вашего долга этому участнику"); only one pending per pair (400 "Предыдущий возврат ещё ждёт подтверждения") |
| POST | `/api/settlements/{id}/confirm` | – | settlement — only `to` user, only if pending (atomic conditional UPDATE; otherwise 400 "Этот возврат уже обработан") |
| POST | `/api/settlements/{id}/reject` | – | same rules as confirm |

`bot_username` comes from env/bot info (see Bot). Errors: `{ "detail": "<Russian message>" }` with status
400/401/403/404/413/422/429. Unexpected errors → 500 `{ "detail": "Внутренняя ошибка сервера" }` with CORS headers.
Amounts in API are integers in minor units. Request body JSON must be validated strictly (types, ranges, lengths).
Request bodies are limited to **64 KB in bytes**: counted while streaming (a missing or false Content-Length is not
trusted) → 413 "Слишком большой запрос"; invalid UTF-8 → 422.

### Split modes (POST expenses)

- `split` omitted or `"equal"`: `participant_ids` required (non-empty, unique, all members). `shares` must be absent.
- `split="exact"`: `shares` required: non-empty list of `{user_id, amount}`; user_ids unique and members;
  every amount is an int > 0; sum must equal `amount` exactly, otherwise 400
  "Сумма долей (X) не совпадает с суммой траты (Y)" (formatted money). `participant_ids` must be absent.
- Payer is always a member; payer may or may not have a share. Response `split` echoes the stored mode.
- "Absent" means missing or `null`; any other value of the wrong-mode field (even `[]`) → 400.
  Errors (400 unless noted): "При равном делении доли не указываются", "При точном делении укажите доли,
  а не список участников", "Укажите доли участников", "Доля каждого участника должна быть больше нуля",
  "Участники не должны повторяться", "Все участники траты должны быть участниками события";
  unknown `split` value or non-integer share → 422 with a Russian `detail`.

## Services (src/core/services.ts) — used by API and bot

All take `deps: Deps` first: `interface Deps { db: D1Database; notify: Notifier; botUsername?: string }`.
`type Notifier = (userId: number, html: string, extra?: { eventId?: number }) => void` — fire-and-forget; the
implementation schedules delivery with `ctx.waitUntil`, so responses never wait for Telegram. Services call
`notify` only after their DB writes succeed. HTML-escape every user-supplied value in texts.

Required exports (names fixed; signatures may add optional params):
`upsertUser`, `createEvent`, `getEventDetail`, `joinByInviteCode(deps, userId, codeOrJoinPayload) -> { event, joinedNow }`,
`listUserEvents`, `addExpense`, `listExpenses`, `deleteExpense`, `getEventBalances`, `createSettlement`,
`listSettlements`, `confirmSettlement`, `rejectSettlement`,
`getUserDebtsSummary(deps, userId) -> [{ eventId, title, currency, net, owes:[{toUser, amount}], owedBy:[{fromUser, amount}] }]`,
`findDebtorsToRemind(deps, now, remindEveryDays, limit) -> [{ eventId, eventTitle, currency, userId, amount }]`
(skips debtors with a pending settlement in that event; ordered never-reminded / least-recently-reminded first,
then event id, user id, so persistently failing rows cannot starve others), `markReminded(deps, eventId, userId, now)`.

## Notifications (to everyone except the actor), with an "Открыть событие" web_app button

- someone joined the event → other members
- event renamed → other members ("Вася переименовал(а) событие «Старое» в «Новое»")
- expense added → participants and payer (amount, description, their own share)
- settlement created → recipient ("Вася отметил, что вернул вам 1 500 ₽ — подтвердите")
- settlement confirmed/rejected → sender
- Delivery errors (blocked bot, chat not found, 429) are swallowed and logged; never retried in a loop.

## Bot (grammY, webhook)

- Webhook only (no polling). `bot.ts` must not call `getMe` on every request: use `botInfo` cached per isolate
  (fetched once and memoized) or provided via config.
- Private chats only.
- `/start` — greeting + button "Открыть" (web_app). `/start join_<code>` — joins the event, replies
  "Вы в событии «…»" / "Вы уже в событии «…»" + button to the event; nice message for invalid code.
- `/help` — short explanation. `/debts` — text summary across events ("Долгов нет 🎉" if none), split at 4096 chars.
- Any other text → hint with commands. Errors → logged, user gets "Что-то пошло не так…".
- Mini App URL: `WEBAPP_URL` + `?event=<id>` when relevant (no `api` param in v2 — the webapp knows its API base).
- `/admin/setup` sets: webhook (`secret_token`, `allowed_updates: ["message"]`, drop pending updates),
  commands (/start, /debts, /help), chat menu button "Открыть" → WEBAPP_URL.
- Reminders (cron hourly): for each debtor (net<0) in each event with no reminder in `REMIND_EVERY_DAYS` days and no
  pending settlement there, send "Напоминание: вы должны X в «…»" + button, then `markReminded`. Process at most a
  safe batch per run (stay under the subrequest limit); the rest go next hour. Unreachable users are marked too.

## Totals across events ("Итого")

Computed from per-event `my_net` (Mini App: from `GET /api/events`; bot: from `getUserDebtsSummary`), grouped by
currency, never converted. Per currency: owe = sum of |net| for net<0, owed = sum of net for net>0, total = owed − owe.
- Mini App, "Мои события": card "Итого по всем событиям" above the list (hidden when there are no events):
  "Вы должны: X" (red), "Вам должны: Y" (green), "В итоге: вам должны Z" / "В итоге: вы должны Z" / "Всё ровно".
  Several currencies → one value per currency joined with " и " (or one row per currency if it reads better).
  Zero parts may be omitted.
- Bot `/debts`: an "<b>Итого</b>" block at the top with the same three lines per currency, then the per-event details.
  If everything is zero → existing "Долгов нет 🎉".

## Mini App (webapp/)

- API base comes from `webapp/config.js`: `window.SPLIT_CONFIG = { apiBase: "https://split-bot.<sub>.workers.dev" }`
  (filled in after first deploy). A `?api=` query param is accepted ONLY if it matches
  `^http://(localhost|127\.0\.0\.1)(:\d+)?$` (local development). Anything else → error screen.
- Screens and behaviour unchanged from v1 (see webapp code): Мои события, Создать событие, Событие (Траты / Балансы /
  Участники), Новая трата with "Поровну" / "Указать суммы", "Я вернул", confirm/reject, invite link, theme support,
  320px+, Telegram BackButton/MainButton, haptics, duplicate-submit protection.
