-- What each production breach was, for observed breach rates (GET /stats/observed-rates):
-- the agent that owns the vault, the breach type, whether the vault blocked it, and when.
-- Breaches recorded before this migration have none of it and are reported as unattributed.
ALTER TABLE handled_events ADD COLUMN agent_id numeric(78,0);
ALTER TABLE handled_events ADD COLUMN breach_type smallint;
ALTER TABLE handled_events ADD COLUMN blocked boolean;
ALTER TABLE handled_events ADD COLUMN occurred_at timestamptz;
