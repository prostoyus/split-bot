# Split Bot — "Who owes whom"

Telegram bot + Mini App for splitting shared expenses (trips, parties, shared flats).

- Create an event and invite friends with a link
- Add expenses: who paid, how much, split between whom
- See balances and the minimal list of transfers ("who owes whom")
- Mark a debt as returned — the recipient confirms it
- Notifications and periodic reminders to debtors

## How it works

```
GitHub Pages (static)                     Your PC: python run.py
https://prostoyus.github.io/split-bot/    ┌────────────────────────────────────┐
  webapp/  ── fetch() ──►                 │ cloudflared quick tunnel (https)   │
                                          │   └► FastAPI  127.0.0.1:8080       │
                                          │ aiogram bot (long polling)         │
                                          │ SQLite  data/split.db              │
                                          └────────────────────────────────────┘
```

- `webapp/` — the Mini App (plain HTML/CSS/JS), served by GitHub Pages.
- `app/` — backend: FastAPI API, SQLite database, business logic, Telegram initData auth.
- `bot/` — aiogram 3 bot: `/start`, `/debts`, `/help`, invite links, notifications, reminders.
- `tunnel.py` — starts a free Cloudflare quick tunnel so the Mini App can reach the API on your PC.
- `run.py` — starts everything in one process.

The bot and the API work only while `run.py` is running. The tunnel URL changes on every start;
the bot passes it to the Mini App automatically.

See [SPEC.md](SPEC.md) for the full technical spec (data model, API, auth).

## Setup (Windows)

1. Create a bot in [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Install dependencies:

   ```
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

3. Download `cloudflared-windows-amd64.exe` from
   [cloudflare/cloudflared releases](https://github.com/cloudflare/cloudflared/releases/latest)
   and save it as `tools\cloudflared.exe`.
4. Copy `.env.example` to `.env` and set `BOT_TOKEN`.
5. Run:

   ```
   .\.venv\Scripts\python.exe run.py
   ```

6. Open your bot in Telegram and press **Start**.

## Tests

```
.\.venv\Scripts\python.exe -m pytest -q
```

## Security notes

- `.env` (bot token) and `data/` (database) are never committed.
- Every API request is authenticated by validating Telegram `initData` (HMAC with the bot token, max age 24h).
- The Mini App only talks to `*.trycloudflare.com` or localhost API addresses.
- Quick tunnel URLs are random and change on every start, so buttons in old bot messages point to a dead
  address. For long-term use, prefer a named Cloudflare tunnel or your own domain and pin that exact URL
  in the `webapp/app.js` whitelist.
