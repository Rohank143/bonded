-- The keeper's view of each TEE-hosted agent (docs/TEE.md, "Live checks"; ADR-013).
-- Keyed like quotes: "<chain id>:<agent id>".
--   status            the latest check's outcome (verified, unrated, mismatch, invalid, unreachable)
--   rated_measurement the on-chain score's TEE measurement the checks were made against
--   evm_address       the TEE agent's key as recorded at rating or last verified; the vault's
--                     execution key must be this key for the TEE discount to apply
--   blocking_status   'mismatch' or 'invalid' until a later pass or a replacement rating clears it.
--                     It survives an 'unreachable' check, so an outage can't clear a failure.
CREATE TABLE tee_checks (
  agent_id text PRIMARY KEY,
  status text NOT NULL,
  detail text,
  measurement text,
  rated_measurement text,
  evm_address text,
  blocking_status text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
