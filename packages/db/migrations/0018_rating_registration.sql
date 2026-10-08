-- What each rating was asked for under, fixed when it is queued, so re-registering an agent
-- can't change how its past ratings are counted or what its current score is allowed to do.
--   ratings.kind           the registration's kind ('remote' for an agent its operator runs;
--                          'hardened', 'partial', ... for Bonded's built-in designs)
--   ratings.charged_owner  the owner its fair-use caps were charged to
--   ratings.config         the registration it rates (the worker runs this, not a later one;
--                          a quote compares it with the current registration)
ALTER TABLE ratings ADD COLUMN kind text;
ALTER TABLE ratings ADD COLUMN charged_owner text;
ALTER TABLE ratings ADD COLUMN config jsonb;
-- Earlier ratings: the best record there is, the registration as it stands now.
UPDATE ratings r SET kind=coalesce(a.config->>'kind',''), charged_owner=a.owner, config=a.config
  FROM agents a WHERE a.id=r.agent_id;
ALTER TABLE ratings ALTER COLUMN kind SET DEFAULT '';
ALTER TABLE ratings ALTER COLUMN kind SET NOT NULL;
CREATE INDEX ratings_kind_created ON ratings(kind, created_at);
