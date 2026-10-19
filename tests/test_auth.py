import time
from urllib.parse import parse_qsl, urlencode

import pytest

from app.auth import InitDataError, validate_init_data
from tests.conftest import ALICE, TEST_BOT_TOKEN, make_init_data


def test_valid_init_data():
    user = validate_init_data(make_init_data(ALICE), TEST_BOT_TOKEN)
    assert user.id == ALICE["id"]
    assert user.first_name == "Алиса"
    assert user.last_name == "Иванова"
    assert user.username == "alice"


def test_tampered_user_rejected():
    fields = dict(parse_qsl(make_init_data(ALICE)))
    fields["user"] = fields["user"].replace(str(ALICE["id"]), "9999")
    with pytest.raises(InitDataError):
        validate_init_data(urlencode(fields), TEST_BOT_TOKEN)


def test_tampered_hash_rejected():
    fields = dict(parse_qsl(make_init_data(ALICE)))
    fields["hash"] = ("0" if fields["hash"][0] != "0" else "1") + fields["hash"][1:]
    with pytest.raises(InitDataError):
        validate_init_data(urlencode(fields), TEST_BOT_TOKEN)


def test_wrong_bot_token_rejected():
    with pytest.raises(InitDataError):
        validate_init_data(make_init_data(ALICE, token="999:other"), TEST_BOT_TOKEN)


def test_expired_rejected():
    old = int(time.time()) - 24 * 3600 - 10
    with pytest.raises(InitDataError) as exc:
        validate_init_data(make_init_data(ALICE, auth_date=old), TEST_BOT_TOKEN)
    assert exc.value.expired


def test_almost_expired_accepted():
    recent = int(time.time()) - 24 * 3600 + 60
    assert validate_init_data(make_init_data(ALICE, auth_date=recent), TEST_BOT_TOKEN).id == ALICE["id"]


@pytest.mark.parametrize(
    "raw",
    ["", "garbage", "hash=abc", "auth_date=1&auth_date=2&hash=x", "a=%FF&hash=%D0%96"],
)
def test_malformed_rejected(raw):
    with pytest.raises(InitDataError):
        validate_init_data(raw, TEST_BOT_TOKEN)


def test_empty_bot_token_rejected():
    with pytest.raises(InitDataError):
        validate_init_data(make_init_data(ALICE), "")
