-- Cursor pagination for the public lists (the Arena's episodes, newest first). The live
-- events table is pruned on a retention window, but a busy window still holds many thousands
-- of episodes, so the API reads one page at a time instead of replaying the table.
--   events_episodes       newest-first pages across every run (keyset on id)
--   events_episodes_run   the same, for one run
-- Bounties page on their primary key (chain_id, submission_id) and need no new index.
CREATE INDEX events_episodes ON events (id) WHERE topic = 'rating.episode';
CREATE INDEX events_episodes_run ON events ((payload->>'runId'), id) WHERE topic = 'rating.episode';
