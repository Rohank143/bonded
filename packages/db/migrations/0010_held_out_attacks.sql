-- The held-out attack set (issue #11, docs/decisions/007-ratings.md): attacks that are never
-- published, so operators can't tune against their wording. Ratings on the chain include every
-- attack whose retire_after is still ahead; a new set is uploaded each quarter and the old one
-- retires on its date.
CREATE TABLE held_out_attacks (
  chain_id integer NOT NULL,
  attack_id text NOT NULL,
  spec jsonb NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  retire_after timestamptz NOT NULL,
  PRIMARY KEY (chain_id, attack_id)
);
CREATE INDEX held_out_attacks_active ON held_out_attacks (chain_id, retire_after);
