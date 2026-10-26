# Mini App (webapp/)

Static files served by GitHub Pages: `index.html`, `config.js`, `app.js`, `style.css`. No build step.

- Opened by the bot as `WEBAPP_URL[?event=<id>]`.
- API base comes from `config.js` (`window.SPLIT_CONFIG.apiBase`, e.g. `https://split-bot.<sub>.workers.dev`);
  it must be a plain https origin (`^https://[a-z0-9.-]+$`, one trailing `/` stripped). Empty → "Приложение ещё не настроено".
- Local dev only: `?api=` is accepted if it matches `^http://(localhost|127\.0\.0\.1)(:\d+)?$`;
  any other `api` value (e.g. old trycloudflare links) → "Неверная ссылка" (no fallback to config).
- Routes (hash, so the query string stays intact): `#/` events, `#/new` create,
  `#/e/<id>` expenses, `#/e/<id>/balances`, `#/e/<id>/members`, `#/e/<id>/add`.
- All user text is inserted via `textContent` (helper `el()` in `app.js`); never use `innerHTML`.
- Outside Telegram (empty `initData`) the page only shows "Откройте через Telegram-бота".

Mobile notes:
- Layout uses `--tg-viewport-stable-height` (not `100vh`) and pads by `--tg-safe-area-inset-*` +
  `--tg-content-safe-area-inset-*` (fullscreen mode), falling back to `env(safe-area-inset-*)`.
- Newer Telegram methods are called only after `isVersionAtLeast()` (BackButton/Haptics 6.1,
  popups/closing confirmation 6.2, vertical swipes 7.7, bottom bar color 7.10, hideKeyboard 9.1).
- While a form has typed input: closing confirmation is on, swipe-down-to-close is off, and Back
  asks before discarding. Submits are guarded against double taps; only one popup at a time.
- Balance colors (`--plus`, `--minus`) are our own, chosen for >= 4.5:1 contrast in light and dark.
