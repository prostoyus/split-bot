-- Split Bot schema (v2, Cloudflare D1 / SQLite).
-- Money: INTEGER minor units (kopecks). Timestamps: INTEGER unix milliseconds (UTC).

CREATE TABLE users (
    id          INTEGER PRIMARY KEY,                -- Telegram user id
    first_name  TEXT    NOT NULL DEFAULT '',
    last_name   TEXT,
    username    TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 64),
    currency    TEXT    NOT NULL DEFAULT 'RUB'
                CHECK (currency IN ('RUB', 'USD', 'EUR', 'KZT', 'UZS', 'UAH', 'BYN', 'TRY', 'GEL')),
    invite_code TEXT    NOT NULL UNIQUE,
    owner_id    INTEGER NOT NULL REFERENCES users (id),
    created_at  INTEGER NOT NULL
);

CREATE INDEX ix_events_created_at ON events (created_at);

CREATE TABLE members (
    event_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users (id),
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (event_id, user_id)
);

CREATE INDEX ix_members_user_id ON members (user_id);

CREATE TABLE expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    payer_id    INTEGER NOT NULL REFERENCES users (id),
    amount      INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000000000),
    description TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 100),
    split_mode  TEXT    NOT NULL DEFAULT 'equal' CHECK (split_mode IN ('equal', 'exact')),
    created_by  INTEGER NOT NULL REFERENCES users (id),
    created_at  INTEGER NOT NULL
);

CREATE INDEX ix_expenses_event_id ON expenses (event_id, created_at);
CREATE INDEX ix_expenses_payer ON expenses (event_id, payer_id);

CREATE TABLE expense_shares (
    expense_id  INTEGER NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users (id),
    amount      INTEGER NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (expense_id, user_id)
);

CREATE INDEX ix_expense_shares_user_id ON expense_shares (user_id);

CREATE TABLE settlements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    from_id     INTEGER NOT NULL REFERENCES users (id),
    to_id       INTEGER NOT NULL REFERENCES users (id),
    amount      INTEGER NOT NULL CHECK (amount > 0),
    status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'rejected')),
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    CHECK (from_id <> to_id)
);

CREATE INDEX ix_settlements_event_id ON settlements (event_id, status);

-- At most one pending settlement per (event, from, to).
CREATE UNIQUE INDEX ux_settlements_one_pending
    ON settlements (event_id, from_id, to_id)
    WHERE status = 'pending';

CREATE TABLE reminders (
    event_id     INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users (id),
    last_sent_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, user_id)
);
