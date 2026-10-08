-- Payloads of the held-out sets made for single ratings of agents their operators run (bring
-- your own agent). An operator sees every attack its agent reads, so no payload is used twice:
-- `freshHeldOut` checks this ledger before using a variant and records each one it uses. Hashes
-- only (`payloadHash` in @bonded/arena); the payloads themselves are never stored.
CREATE TABLE held_out_payloads (
  hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
