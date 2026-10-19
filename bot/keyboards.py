"""Mini App URL builder and inline keyboards."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

OPEN_APP_TEXT = "Открыть"
OPEN_EVENT_TEXT = "Открыть событие"


def build_webapp_url(webapp_url: str, api_base: str, event_id: int | None = None) -> str:
    """Return `WEBAPP_URL?api=<urlencoded api base>[&event=<id>]`.

    Existing query parameters of WEBAPP_URL are kept; a URL fragment is preserved at the end.
    """
    if not webapp_url:
        raise ValueError("webapp_url is empty")
    parts = urlsplit(webapp_url.strip())
    params = [f"api={quote(api_base.strip().rstrip('/'), safe='')}"]
    if event_id is not None:
        params.append(f"event={int(event_id)}")
    query = "&".join(([parts.query] if parts.query else []) + params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


@dataclass(frozen=True)
class WebAppLinks:
    """Everything needed to build Mini App links (passed to handlers as `links`)."""

    webapp_url: str
    api_base: str

    def url(self, event_id: int | None = None) -> str:
        return build_webapp_url(self.webapp_url, self.api_base, event_id)


def open_app_keyboard(links: WebAppLinks) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=OPEN_APP_TEXT, web_app=WebAppInfo(url=links.url()))]
        ]
    )


def open_event_keyboard(links: WebAppLinks, event_id: int | None) -> InlineKeyboardMarkup:
    text = OPEN_EVENT_TEXT if event_id is not None else OPEN_APP_TEXT
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=text, web_app=WebAppInfo(url=links.url(event_id)))]
        ]
    )
