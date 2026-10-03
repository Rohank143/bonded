-- The nonce a pending accept or reject was given before broadcast. With no hash recorded, a
-- retry checks it: used and still unsettled means the send never landed (safe to send again);
-- unused means it re-sends the same call with the same nonce, so at most one can ever mine.
ALTER TABLE bounties ADD COLUMN pending_nonce numeric(78,0);
