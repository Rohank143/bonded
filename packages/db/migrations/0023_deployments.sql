-- Which deployment (registry address) the database holds on-chain state for, per chain. Agents,
-- policies, claims and bounties are keyed by chain and on-chain id only, and a redeployment
-- numbers them from 1 again, so when a chain's registry changes every service clears that chain's
-- on-chain state at startup (Database.adoptDeployment) before using it.
CREATE TABLE deployments (
  chain_id integer PRIMARY KEY,
  registry text NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now()
);
-- A database that already holds Robinhood Chain testnet agents holds them for the deployment of
-- Sep 27, 2026, the only one the hosted service has used before this table existed.
INSERT INTO deployments (chain_id, registry)
SELECT 46630, '0x35f6d30be731a639235ccad7abedda4d4be8d4f9'
WHERE EXISTS (SELECT 1 FROM agents WHERE chain_id = 46630);

-- The keeper's cursor belongs to one deployment. Keying it by registry means a keeper still
-- running the old code (during a deploy's overlap) can't move the new deployment's cursor: its
-- ON CONFLICT(chain_id) no longer matches a unique key, so its write fails instead. Existing
-- cursors keep an empty registry and are ignored, so the keeper starts at deployedAtBlock.
ALTER TABLE keeper_cursors ADD COLUMN registry text NOT NULL DEFAULT '';
ALTER TABLE keeper_cursors DROP CONSTRAINT keeper_cursors_pkey;
ALTER TABLE keeper_cursors ADD PRIMARY KEY (chain_id, registry);
