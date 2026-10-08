-- Bring your own agent (docs/BRING-YOUR-OWN-AGENT.md). An agent's owner creates a runner token by
-- signing in their wallet; @bonded/runner presents it to the Arena Gateway on the arena-worker.
--   token_hash   sha256 of the token, hex. The token itself is shown once and never stored.
--   signed_at    the signed request's timestamp. A later request must be signed later, so a
--                captured signature can't be replayed to rotate or revoke a token again.
--   revoked_at   set by DELETE /self/agents/:id/runner-token, or when a new token replaces it.
-- At most one live token per agent.
CREATE TABLE runner_tokens (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  signed_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_signed_at bigint
);
CREATE UNIQUE INDEX runner_tokens_live ON runner_tokens(agent_id) WHERE revoked_at IS NULL;
-- The runner each agent has connected, as the worker sees it. A runner counts as connected while
-- `connected` and its last heartbeat is recent: a worker that died can't leave it connected.
--   connection_id  one per WebSocket connection, so a replaced connection's late heartbeat or
--                  disconnect can't touch the newer one.
CREATE TABLE runner_presence (
  agent_id text PRIMARY KEY REFERENCES agents(id),
  token_id uuid NOT NULL REFERENCES runner_tokens(id),
  connection_id uuid NOT NULL,
  connected boolean NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  runner_version text,
  mode text,
  tee_url text
);
-- Ratings the live loop decided not to queue, and why (e.g. a bounty was accepted while the
-- agent's runner was offline). Kept apart from `ratings`, so a skip never counts as a rating.
CREATE TABLE rating_skips (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  cause text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_skips_agent ON rating_skips(agent_id, created_at);
