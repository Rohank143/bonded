-- Bring your own agent, launch round: vault trading status, more notifications (an in-app inbox
-- and per-owner opt-outs) and funnel counts.
--
-- Each Executed event of a vault or smart-account module, indexed by the keeper with the same
-- cursor as breaches: the agent's trades through it (only the agent key can call execute).
--   outflow_usd6  value out of the vault, as the vault measured it
--   gas_used      the transaction's gas, for the agent key's trades-left estimate
CREATE TABLE vault_trades (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  vault text NOT NULL,
  target text NOT NULL,
  selector text NOT NULL,
  outflow_usd6 numeric(78,0) NOT NULL,
  tx_hash text NOT NULL,
  block_number numeric(78,0) NOT NULL,
  occurred_at timestamptz NOT NULL,
  gas_used numeric(78,0)
);
CREATE INDEX vault_trades_vault ON vault_trades(chain_id, vault, occurred_at DESC);

-- When the keeper first sent a claim for a breach (the owner hears "claim filed" once).
ALTER TABLE handled_events ADD COLUMN claim_filed_at timestamptz;

-- Every notification an owner was sent, newest first, for the in-app list
-- (GET /self/notifications/inbox). `dedupe_key` names the event, so it is sent once.
--   subject  "<chain>:<agent id>" or "preview:<id>"
CREATE TABLE owner_notifications (
  id bigserial PRIMARY KEY,
  owner text NOT NULL,
  type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  subject text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX owner_notifications_owner ON owner_notifications(owner, id DESC);

-- Notification types the owner turned off (NOTIFICATION_TYPES in @bondedhq/shared).
ALTER TABLE notification_settings ADD COLUMN muted text[] NOT NULL DEFAULT '{}';

-- Funnel counts (GET /stats/funnel, operator only): how many times each step happened per day.
-- Counters only: no wallet, no id, no address.
CREATE TABLE funnel_daily (
  day date NOT NULL,
  step text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step)
);
