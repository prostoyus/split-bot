/* Mini App settings. This is our own file, served from GitHub Pages next to app.js.
 * apiBase: the backend URL, filled in after the first Cloudflare Workers deploy,
 * e.g. "https://split-bot.<subdomain>.workers.dev" (https, no path, no trailing slash).
 * While empty, the app shows "Приложение ещё не настроено" (unless ?api=http://127.0.0.1:<port> is used for local dev).
 */
window.SPLIT_CONFIG = { apiBase: "https://split-bot.split-bot.workers.dev" };
