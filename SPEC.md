# Split Bot ("Who owes whom") — technical spec

Telegram bot + Mini App for splitting shared expenses (trips, parties, flats).
Single source of truth for all agents. Do not change contracts here without updating this file.

## Runtime architecture

```
GitHub Pages (static)                 User's PC (python run.py)
https://prostoyus.github.io/          ┌──────────────────────────────────────┐
  split-bot/webapp/  ──fetch()──►     │ cloudflared quick tunnel (https)     │
  (index.html, app.js, style.css)     │   └► uvicorn FastAPI  127.0.0.1:8080 │
                                      │ aiogram 3 bot (long polling)         │
                                      │ SQLite file data/split.db            │
                                      └──────────────────────────────────────┘
```

- `run.py` starts `tools/cloudflared.exe tunnel --url http://127.0.0.1:8080`, reads the
  `https://<random>.trycloudflare.com` URL from its output, then runs FastAPI (uvicorn) and the
  aiogram bot in ONE asyncio event loop. If `PUBLIC_API_URL` is set in `.env`, the tunnel is skipped
  and that URL is used (useful for tests / other hosting).
- The bot opens the Mini App with URL `WEBAPP_URL?api=<urlencoded API base URL>` (+ `&event=<id>` when
  relevant). The frontend reads `api` from the query string and **only accepts** it if it matches
  `^https://[a-z0-9-]+\.trycloudflare\.com$` or `^http://(localhost|127\.0\.0\.1)(:\d+)?$`
  (otherwise show an error). This prevents phishing links from sending initData elsewhere.
- Everything works only while `run.py` is running (same as snake-bot).

## Tech

- Python 3.13, venv in `.venv/`. Deps in `requirements.txt`: aiogram 3, fastapi, uvicorn, sqlalchemy 2 (async),
  aiosqlite, python-dotenv, pytest, pytest-asyncio, httpx.
- Frontend: plain HTML/CSS/JS, no build step, no npm. Telegram WebApp SDK from
  `https://telegram.org/js/telegram-web-app.js`.
- Code, comments, commits in English. User-facing texts in Russian.

## Config (.env, never committed)

```
BOT_TOKEN=            # from @BotFather
WEBAPP_URL=https://prostoyus.github.io/split-bot/webapp/
PUBLIC_API_URL=       # optional; if empty, cloudflared tunnel is used
API_PORT=8080
DB_PATH=data/split.db
REMIND_EVERY_DAYS=3
ALLOWED_ORIGINS=https://prostoyus.github.io   # comma separated; localhost always allowed
```

## Project layout

```
split-bot/
  run.py               # entry point (telegram-bot-dev)
  tunnel.py            # cloudflared launcher (telegram-bot-dev)
  app/                 # backend (backend-architect)
    config.py db.py models.py auth.py services.py api.py notifier.py
  bot/                 # telegram bot (telegram-bot-dev)
    main.py handlers.py reminders.py keyboards.py
  webapp/              # Mini App (frontend-developer, mobile-app-builder)
    index.html app.js style.css
  tests/               # pytest
  tools/cloudflared.exe  (gitignored)
  data/                  (gitignored)
  requirements.txt .env.example .gitignore README.md SPEC.md
```

## Data model (SQLite, SQLAlchemy async)

Money is stored as **integer minor units** (kopecks). Never floats.

- `users`: `id` (Telegram user id, PK), `first_name`, `last_name`, `username`, `created_at`
- `events`: `id`, `title` (1..64 chars), `currency` (default `RUB`; one of RUB, USD, EUR, KZT, UZS, UAH, BYN, TRY, GEL),
  `invite_code` (random url-safe 10 chars, unique), `owner_id`, `created_at`
- `members`: `event_id`, `user_id`, `joined_at` (PK event_id+user_id)
- `expenses`: `id`, `event_id`, `payer_id`, `amount` (>0, <= 100_000_000_00), `description` (1..100),
  `created_by`, `created_at`
- `expense_shares`: `expense_id`, `user_id`, `amount` — shares always sum exactly to `amount`.
  - `split="equal"`: remainder kopecks go one each to the first participants by user id order.
  - `split="exact"`: shares are given by the client (see API).
- `expenses.split_mode`: `equal|exact` (default `equal`; added column, migrate existing DBs in `init_db`).
- `settlements`: `id`, `event_id`, `from_id`, `to_id`, `amount`, `status` (`pending|confirmed|rejected`),
  `created_at`, `resolved_at`. At most one `pending` settlement per (event, from, to) — partial unique index.
- `reminders`: `event_id`, `user_id`, `last_sent_at` (for reminder throttling)

## Balance rules

- net(user) = sum(paid expenses) − sum(own shares) + sum(confirmed settlements sent) − sum(confirmed settlements received).
  net > 0 → others owe the user; net < 0 → user owes.
- Sum of all nets in an event is always 0.
- "Who owes whom" = greedy minimization: repeatedly match the largest debtor with the largest creditor.
  Deterministic order (tie-break by user id).

## Auth

- Every `/api/*` request (except `GET /api/health`) must send header `X-Telegram-Init-Data: <Telegram.WebApp.initData>`.
- Backend validates per Telegram docs: HMAC-SHA256 with secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN),
  constant-time compare, reject if `auth_date` older than 24h. On success upsert the user from the `user` field.
- 401 on invalid/missing. 403 if user is not a member of the event. 404 for unknown ids.
- CORS: allow origins from `ALLOWED_ORIGINS` plus `http://localhost:*` / `http://127.0.0.1:*`; allow header `X-Telegram-Init-Data`, `Content-Type`.

## REST API (JSON, prefix `/api`)

User object everywhere: `{ "id": int, "name": str, "username": str|null }` (`name` = first + last name).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ "ok": true }` (no auth) |
| GET | `/api/config` | – | `{ "bot_username": str }` |
| GET | `/api/me` | – | user |
| GET | `/api/events` | – | `[{ id, title, currency, members_count, my_net }]` newest first |
| POST | `/api/events` | `{ title, currency? }` | event detail (creator becomes member) |
| GET | `/api/events/{id}` | – | `{ id, title, currency, invite_code, invite_link, owner_id, members:[user], my_net }` — `invite_link` = `https://t.me/<bot_username>?start=join_<invite_code>` |
| POST | `/api/join` | `{ invite_code }` | event detail (idempotent) |
| GET | `/api/events/{id}/expenses` | – | `[{ id, payer:user, amount, description, split, created_at, created_by, shares:[{user, amount}] }]` newest first |
| POST | `/api/events/{id}/expenses` | `{ amount, description, payer_id, split?: "equal"\|"exact", participant_ids?:[int], shares?:[{user_id, amount}] }` | expense. See "Split modes" below |
| DELETE | `/api/expenses/{id}` | – | `{ "ok": true }` — only creator or payer |
| GET | `/api/events/{id}/balances` | – | `{ balances:[{ user, net }], transfers:[{ from:user, to:user, amount }] }` |
| GET | `/api/events/{id}/settlements` | – | `[{ id, from:user, to:user, amount, status, created_at }]` newest first |
| POST | `/api/events/{id}/settlements` | `{ to_id, amount }` | settlement (status pending); from = current user; to must be member, != self. `amount` ≤ sender's debt to `to` = amount of the current minimal transfer from→to minus sender's pending settlements to `to` (no such transfer → 400 "Сумма больше вашего долга этому участнику"); only one pending per pair (400 "Предыдущий возврат ещё ждёт подтверждения") |
| POST | `/api/settlements/{id}/confirm` | – | settlement — only `to` user, only if pending (atomic conditional UPDATE; otherwise 400 "Этот возврат уже обработан") |
| POST | `/api/settlements/{id}/reject` | – | same rules as confirm |

Errors: `{ "detail": "<Russian human-readable message>" }` with proper status codes (400/401/403/404/422/429).
Unexpected errors → 500 `{ "detail": "Внутренняя ошибка сервера" }`, produced inside the CORS layer so CORS headers are present.
Amounts in API are integers in minor units.

### Split modes (POST expenses)

- `split` omitted or `"equal"`: `participant_ids` required (non-empty, unique, all members); equal split as before.
  `shares` must be absent.
- `split="exact"`: `shares` required: non-empty list of `{user_id, amount}`; user_ids unique and members;
  every amount is an int > 0; sum of amounts must equal `amount` exactly, otherwise 400
  "Сумма долей (X) не совпадает с суммой траты (Y)" (formatted money). `participant_ids` must be absent.
- Payer is always a member; payer may or may not have a share.
- Response `split` field echoes the stored mode.
- "Absent" means missing or `null`; any other value of the wrong-mode field (even `[]`) → 400.
  Errors (400 unless noted): "При равном делении доли не указываются", "При точном делении укажите доли,
  а не список участников", "Укажите доли участников", "Доля каждого участника должна быть больше нуля",
  "Участники не должны повторяться", "Все участники траты должны быть участниками события";
  unknown `split` value or non-integer share → 422 with a Russian `detail`.

## Notifications (app/notifier.py)

Backend never imports aiogram. It calls an injected async callable:

```python
# app/notifier.py
Notify = Callable[[int, str, dict | None], Awaitable[None]]  # (user_id, html_text, extra) ; extra may hold {"event_id": int}
set_notifier(fn); async def notify(user_id, text, extra=None)  # no-op if not set; swallow & log errors
async def drain(timeout)  # await pending deliveries; cancel leftovers after timeout
```

`notify()` does not wait for delivery: it schedules a background task (strong refs kept until done), so HTTP
responses are never blocked by Telegram. Call `drain(timeout)` on shutdown (and in tests before asserting).

The bot wires it in `run.py` so notifications are sent with an "Открыть" web_app button to the event.
Events that trigger notifications (to everyone except the actor):
- someone joined the event → other members
- expense added → participants and payer (show amount, description, their share)
- settlement created → recipient ("Вася отметил, что вернул вам 1 500 ₽ — подтвердите")
- settlement confirmed/rejected → sender

## Bot (aiogram 3)

- `/start` — greeting + button "Открыть" (web_app). Sets chat menu button to web_app.
- `/start join_<code>` — joins the event (via app.services), replies "Вы в событии «…»" + button opening that event.
- `/help` — short explanation in Russian.
- `/debts` — text summary of what the user owes / is owed across events.
- Reminders: background task, every hour checks; for each debtor (net<0) in each event, if no reminder in
  `REMIND_EVERY_DAYS` days, send "Напоминание: вы должны X ₽ в «…»" with button. Throttle via `reminders` table.
  Debtors who have a pending settlement in that event are skipped (waiting for confirmation).
- Bot may call `app.services` functions directly (same process, same DB).

## Mini App screens (Russian UI, Telegram theme colors via CSS vars `--tg-theme-*`)

1. **Мои события** — list with my balance per event (green "вам должны", red "вы должны"), button "Создать событие".
2. **Создать событие** — title, currency.
3. **Событие** (tabs): **Траты** (list + add), **Балансы** (who owes whom + "Я вернул" button on my transfers),
   **Участники** (list + "Пригласить" button → `Telegram.WebApp.openTelegramLink("https://t.me/share/url?url=<invite_link>&text=...")` and copy link).
   Pending settlements addressed to me show "Подтвердить / Отклонить".
4. **Добавить трату** — amount (decimal input in major units, converted to kopecks), description, who paid (select), split between (checkboxes, all by default).
- Use Telegram MainButton / BackButton where natural, haptic feedback, `Telegram.WebApp.ready()` and `expand()`.
- Opened with `?event=<id>` → go directly to that event.
- Money formatting: `1 500,50 ₽` style (ru-RU), currency symbol by code.
- Must work in light and dark Telegram themes, 320px+ width.
- For local testing outside Telegram: if `Telegram.WebApp.initData` is empty, show a clear message "Откройте через Telegram-бота".
