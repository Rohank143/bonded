-- A send can be accepted by the RPC before its receipt (or even hash) reaches the worker.
-- Keep that uncertainty durable; retry exhaustion must never discard a later mined payout.
ALTER TABLE bounties ADD COLUMN broadcast_pending boolean NOT NULL DEFAULT false;
ALTER TABLE bounties ADD COLUMN pending_tx_hash text;
