-- Supports the "max events per owner" check (COUNT by owner_id inside INSERT ... SELECT).
CREATE INDEX ix_events_owner_id ON events (owner_id);
