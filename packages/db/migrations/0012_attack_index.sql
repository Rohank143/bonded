-- One attack's episodes (the red team page's stats and the Arena's attack filter), newest first.
CREATE INDEX events_episodes_attack ON events ((payload->'episode'->>'attackId'), id)
  WHERE topic = 'rating.episode';
