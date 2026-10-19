from types import SimpleNamespace

from app.services import DebtReminder, TransferView, UserEventDebts
from bot.handlers import format_debts_summary, parse_join_code, split_message
from bot.reminders import reminder_text


def _user(uid, name):
    return SimpleNamespace(id=uid, display_name=name)


def test_no_debts():
    assert format_debts_summary([]) == "Долгов нет 🎉"


def test_summary_lists_owes_and_owed_and_escapes():
    me, bob, eve = _user(1, "Я"), _user(2, "Боб"), _user(3, "<Ева>")
    items = [
        UserEventDebts(
            event_id=1,
            title="Поездка <в> Казань",
            currency="RUB",
            net=-150050,
            owes=[TransferView(from_user=me, to_user=bob, amount=150050)],
        ),
        UserEventDebts(
            event_id=2,
            title="Квартира",
            currency="USD",
            net=1000,
            owed_by=[TransferView(from_user=eve, to_user=me, amount=1000)],
        ),
    ]
    text = format_debts_summary(items)
    assert "«Поездка &lt;в&gt; Казань»" in text
    assert "Вы должны: Боб — 1 500,50 ₽" in text
    assert "&lt;Ева&gt; — 10 $" in text
    assert "<Ева>" not in text


def test_parse_join_code():
    assert parse_join_code("join_abc") == "join_abc"
    assert parse_join_code(" join_abc ") == "join_abc"
    assert parse_join_code("hello") is None
    assert parse_join_code(None) is None
    assert parse_join_code("") is None


def test_split_message_respects_limit():
    text = "\n".join(f"line {i} " + "x" * 50 for i in range(300))
    chunks = split_message(text, limit=1000)
    assert all(len(c) <= 1000 for c in chunks)
    assert "\n".join(chunks) == text


def test_split_message_hard_cuts_long_line():
    chunks = split_message("a" * 2500, limit=1000)
    assert [len(c) for c in chunks] == [1000, 1000, 500]


def test_short_message_is_not_split():
    assert split_message("hi") == ["hi"]


def test_reminder_text_escapes_title():
    r = DebtReminder(event_id=1, event_title="A&B", currency="RUB", user_id=5, amount=50000)
    assert reminder_text(r) == "Напоминание: вы должны 500 ₽ в «A&amp;B»"
