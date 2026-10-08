-- Agents their operators run (bring your own agent): what a stopped rating costs.
--   ratings.agent_caused  the rating stopped because of the agent (crash, timeout, too slow).
--   ratings.agent_report  what the agent or its runner said about it, kept apart from the
--                         system's own reason (ratings.error), because the operator controls it.
--   agent_standing        after an agent-caused stop the current score is superseded (no quotes
--                         until a complete rating posts), and a cooldown that doubles with each
--                         failure in a row (1 h, 2 h, 4 h ... 48 h) holds the next rating back.
ALTER TABLE ratings ADD COLUMN agent_caused boolean NOT NULL DEFAULT false;
ALTER TABLE ratings ADD COLUMN agent_report text;
CREATE TABLE agent_standing (
  agent_id text PRIMARY KEY REFERENCES agents(id),
  failures_in_row integer NOT NULL DEFAULT 0,
  superseded_at timestamptz,
  superseded_reason text,
  cooldown_until timestamptz
);
