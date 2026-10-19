"""Money helpers. Amounts are integers in minor units (kopecks, cents...)."""

from __future__ import annotations

CURRENCY_SYMBOLS: dict[str, str] = {
    "RUB": "₽",
    "USD": "$",
    "EUR": "€",
    "KZT": "₸",
    "UZS": "сум",
    "UAH": "₴",
    "BYN": "Br",
    "TRY": "₺",
    "GEL": "₾",
}

CURRENCIES: tuple[str, ...] = tuple(CURRENCY_SYMBOLS)


def currency_symbol(currency: str) -> str:
    return CURRENCY_SYMBOLS.get(currency, currency)


def format_money(amount: int, currency: str = "RUB") -> str:
    """Format minor units in Russian style: 150050 -> '1 500,50 ₽', 150000 -> '1 500 ₽'."""
    sign = "-" if amount < 0 else ""
    major, minor = divmod(abs(int(amount)), 100)
    major_str = f"{major:,}".replace(",", " ")
    number = f"{major_str},{minor:02d}" if minor else major_str
    return f"{sign}{number} {currency_symbol(currency)}"
