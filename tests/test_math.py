import random

import pytest

from app.money import format_money
from app.services import minimize_transfers, split_equally


def test_split_exact():
    assert split_equally(300, [3, 1, 2]) == {1: 100, 2: 100, 3: 100}


def test_split_remainder_goes_to_lowest_ids():
    shares = split_equally(1000, [30, 10, 20])
    assert shares == {10: 334, 20: 333, 30: 333}
    assert sum(shares.values()) == 1000


def test_split_less_than_participants():
    assert split_equally(2, [5, 4, 3]) == {3: 1, 4: 1, 5: 0}


def test_split_random_sums():
    rnd = random.Random(42)
    for _ in range(500):
        ids = rnd.sample(range(1, 1000), rnd.randint(1, 15))
        amount = rnd.randint(1, 10**10)
        shares = split_equally(amount, ids)
        assert sum(shares.values()) == amount
        assert max(shares.values()) - min(shares.values()) <= 1


def test_split_empty_raises():
    with pytest.raises(ValueError):
        split_equally(100, [])


def test_transfers_simple():
    assert minimize_transfers({1: 200, 2: -100, 3: -100}) == [(2, 1, 100), (3, 1, 100)]


def test_transfers_largest_first_and_tie_break():
    nets = {1: 500, 2: 300, 3: -600, 4: -200}
    assert minimize_transfers(nets) == [(3, 1, 500), (4, 2, 200), (3, 2, 100)]
    # Equal debts/credits: lower user id wins.
    assert minimize_transfers({5: 100, 2: 100, 9: -100, 3: -100}) == [(3, 2, 100), (9, 5, 100)]


def test_transfers_settle_everything():
    rnd = random.Random(7)
    for _ in range(300):
        n = rnd.randint(2, 10)
        nets = {i: rnd.randint(-10**6, 10**6) for i in range(1, n)}
        nets[n] = -sum(nets.values())
        transfers = minimize_transfers(nets)
        assert len(transfers) <= n - 1
        result = dict(nets)
        for f, t, a in transfers:
            assert a > 0
            result[f] += a
            result[t] -= a
        assert all(v == 0 for v in result.values())


def test_transfers_all_zero():
    assert minimize_transfers({1: 0, 2: 0}) == []


@pytest.mark.parametrize(
    "amount,currency,expected",
    [
        (150050, "RUB", "1 500,50 ₽"),
        (150000, "RUB", "1 500 ₽"),
        (5, "USD", "0,05 $"),
        (-123456789, "EUR", "-1 234 567,89 €"),
        (0, "KZT", "0 ₸"),
    ],
)
def test_format_money(amount, currency, expected):
    assert format_money(amount, currency) == expected
