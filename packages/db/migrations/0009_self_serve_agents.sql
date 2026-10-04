-- Self-serve agents (docs/PLAN.md, Day 14 workstream 7). An agent is either configured by the
-- operator (the AGENTS_FILE, reconciled on start) or registered by its owner through the API.
--   source   'operator' or 'user'. Reconciling the operator's file only touches operator agents.
--   owner    for user agents, the address that signed the registration (the agent's owner).
ALTER TABLE agents ADD COLUMN source text NOT NULL DEFAULT 'operator';
ALTER TABLE agents ADD COLUMN owner text;
