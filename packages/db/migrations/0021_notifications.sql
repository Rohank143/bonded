-- Notifications when a preview or a rating finishes, fails or is refused (bring your own agent).
--   webhook_secret_ciphertext  the webhook's signing secret, encrypted like an agent URL secret
--   email                      only used when the service has an email sender configured
CREATE TABLE notification_settings (
  owner text PRIMARY KEY,
  webhook_url text,
  webhook_secret_ciphertext text,
  email text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One notification per rating and outcome, so a retried finish doesn't send it twice.
CREATE TABLE notifications_sent (
  rating_id uuid NOT NULL REFERENCES ratings(id),
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rating_id, type)
);
