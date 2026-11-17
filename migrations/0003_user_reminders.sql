-- Weekly reminders by totals across events: one row per user (replaces the per-event `reminders`
-- table, which stays in the schema unused). last_sent_at: unix ms. The PK is the only index needed.
CREATE TABLE user_reminders (
    user_id      INTEGER PRIMARY KEY REFERENCES users (id),
    last_sent_at INTEGER NOT NULL
);
