-- Community attack bounties (docs/PLAN.md Section 13.1). One row per revealed BountyBoard
-- submission whose spec the hunter posted to the API, keyed by chain and submission id.
--   spec_yaml / spec   the attack exactly as revealed (its sha256 is the on-chain specURI)
--   status             validating, accepted, rejected or failed (validation errored three times)
--   verdict            the Arena's deterministic decision (apps/arena/src/bounty.ts)
--   tx_hash            the attester's accept or reject transaction
--   attempts, token, lease_until, available_at   the same lease queue as rating jobs
-- Accepted specs join the attack library for every later rating on that chain.
CREATE TABLE bounties (
  chain_id integer NOT NULL,
  submission_id numeric(78,0) NOT NULL,
  hunter text NOT NULL,
  spec_uri text NOT NULL,
  spec_yaml text NOT NULL,
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'validating',
  verdict jsonb,
  tx_hash text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, submission_id)
);
CREATE INDEX bounties_queue ON bounties(chain_id, status, available_at);
CREATE UNIQUE INDEX bounties_accepted_attack ON bounties(chain_id, (spec->>'id')) WHERE status='accepted';
