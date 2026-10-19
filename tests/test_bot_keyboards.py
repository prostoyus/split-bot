from urllib.parse import parse_qs, urlsplit

import pytest

from bot.keyboards import WebAppLinks, build_webapp_url, open_event_keyboard

WEBAPP = "https://prostoyus.github.io/split-bot/webapp/"
API = "https://abc-def-123.trycloudflare.com"


def test_url_without_event():
    url = build_webapp_url(WEBAPP, API)
    assert url == WEBAPP + "?api=https%3A%2F%2Fabc-def-123.trycloudflare.com"
    assert parse_qs(urlsplit(url).query) == {"api": [API]}


def test_url_with_event():
    url = build_webapp_url(WEBAPP, API, 42)
    assert url == WEBAPP + "?api=https%3A%2F%2Fabc-def-123.trycloudflare.com&event=42"


def test_trailing_slash_of_api_is_removed_and_localhost_encoded():
    url = build_webapp_url(WEBAPP, "http://127.0.0.1:8080/")
    assert parse_qs(urlsplit(url).query)["api"] == ["http://127.0.0.1:8080"]


def test_existing_query_and_fragment_are_kept():
    url = build_webapp_url("https://x.io/app/?v=2#top", API, 7)
    parts = urlsplit(url)
    assert parse_qs(parts.query) == {"v": ["2"], "api": [API], "event": ["7"]}
    assert parts.fragment == "top"


def test_empty_webapp_url_rejected():
    with pytest.raises(ValueError):
        build_webapp_url("", API)


def test_event_keyboard_has_web_app_button():
    kb = open_event_keyboard(WebAppLinks(WEBAPP, API), 5)
    button = kb.inline_keyboard[0][0]
    assert button.text == "Открыть событие"
    assert button.web_app.url.endswith("&event=5")


def test_keyboard_without_event_opens_app():
    kb = open_event_keyboard(WebAppLinks(WEBAPP, API), None)
    button = kb.inline_keyboard[0][0]
    assert button.text == "Открыть"
    assert "event=" not in button.web_app.url
