-- Sentinel checks agents ask for through POST /sentinel/check (docs/SENTINEL.md). One row per
-- check: which agent, when, the "manipulated" probability and whether it blocked. The action
-- and what the agent read are never stored. Agent pages show the counts; rows past the event
-- retention window are pruned with the events.
CREATE TABLE sentinel_checks (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  agent_id numeric(78,0) NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  manipulated real NOT NULL,
  blocked boolean NOT NULL,
  latency_ms integer NOT NULL
);
CREATE INDEX sentinel_checks_agent ON sentinel_checks (chain_id, agent_id, checked_at);
CREATE INDEX sentinel_checks_recent ON sentinel_checks (chain_id, checked_at);
