-- The keeper's latest live check of each TEE-hosted agent (docs/TEE.md, "Live checks").
-- Keyed like quotes: "<chain id>:<agent id>". verified_at keeps the last time it passed.
CREATE TABLE tee_checks (
  agent_id text PRIMARY KEY,
  status text NOT NULL,
  detail text,
  measurement text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
