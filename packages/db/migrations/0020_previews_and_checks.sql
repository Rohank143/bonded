-- Bring your own agent, round 2 (docs/BRING-YOUR-OWN-AGENT.md): previews, Agent URLs, connection
-- checks and the code hash the runner reports. Independent of 0019.
--
-- Owner sessions: a wallet signs "Bonded: sign in" once and gets a short-lived session for the
-- preview, check, Agent URL and notification routes. Only the token's sha256 is kept; each
-- signature can open one session (signature_hash is unique), so a captured one can't be replayed.
CREATE TABLE owner_sessions (
  token_hash text PRIMARY KEY,
  chain_id integer NOT NULL,
  wallet text NOT NULL,
  signature_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX owner_sessions_wallet ON owner_sessions(wallet, created_at);

-- A preview rating: an agent rated without a vault, a bond or an on-chain registration. It
-- belongs to a wallet. Its score is never attested or posted and can't be used for quotes.
--   connection   how Bonded reaches the agent: 'runner' or 'url' (Agent URL mode)
--   code_hash    declared by the owner, or null: then the runner's or URL's reported one is used
--   rating_id    its latest rating (ratings.kind = 'preview')
--   upgraded_to  the agent ("<chain>:<agent id>") registered from it with "Make it official"
CREATE TABLE previews (
  id uuid PRIMARY KEY,
  chain_id integer NOT NULL,
  owner text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('tools', 'chain')),
  connection text NOT NULL CHECK (connection IN ('runner', 'url')),
  code_hash text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN
    ('created', 'checking', 'ready', 'queued', 'running', 'done', 'failed', 'refused', 'stopped')),
  rating_id uuid,
  error text,
  upgraded_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX previews_owner ON previews(owner, created_at);
CREATE INDEX previews_created ON previews(chain_id, created_at);

-- Ratings of previews use the ratings table with no agent. Each rating also records the code
-- hash it rated and where that came from ('declared', or the runner's own source such as 'git',
-- 'image', 'unpinned', or 'url'), and its progress (counts only) while it runs.
ALTER TABLE ratings ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE ratings ADD COLUMN preview_id uuid REFERENCES previews(id);
ALTER TABLE ratings ADD COLUMN code_hash text;
ALTER TABLE ratings ADD COLUMN code_source text;
ALTER TABLE ratings ADD COLUMN progress jsonb;
ALTER TABLE ratings ADD CONSTRAINT ratings_subject CHECK ((agent_id IS NULL) <> (preview_id IS NULL));
CREATE INDEX ratings_preview ON ratings(preview_id) WHERE preview_id IS NOT NULL;
ALTER TABLE previews ADD CONSTRAINT previews_rating FOREIGN KEY (rating_id) REFERENCES ratings(id);

-- Runner tokens and runner presence can belong to a preview ("preview:<id>") as well as to an
-- agent ("<chain>:<agent id>"), so their key no longer references agents alone. The runner's
-- reported code hash (and its source) is kept with its presence.
ALTER TABLE runner_tokens DROP CONSTRAINT runner_tokens_agent_id_fkey;
ALTER TABLE runner_presence DROP CONSTRAINT runner_presence_agent_id_fkey;
ALTER TABLE runner_tokens ADD CONSTRAINT runner_tokens_key
  CHECK (agent_id ~ '^([0-9]+:[0-9]+|preview:[0-9a-f-]{36})$');
ALTER TABLE runner_presence ADD COLUMN code_hash text;
ALTER TABLE runner_presence ADD COLUMN code_source text;

-- Agent URL mode: Bonded calls the agent's HTTPS endpoint for each episode, signing each call
-- with the agent secret. The secret has to be usable to sign, so it is stored encrypted
-- (AES-256-GCM, AGENT_URL_SECRET_KEY), never in the clear, and never returned after creation.
--   owner_key   "<chain>:<agent id>" or "preview:<id>"
--   version     what the agent reported when it answered the verify challenge
--   code_hash   keccak256("url:" + version): the code hash used when none is declared
-- At most one live URL per agent or preview.
CREATE TABLE agent_urls (
  id uuid PRIMARY KEY,
  owner_key text NOT NULL CHECK (owner_key ~ '^([0-9]+:[0-9]+|preview:[0-9a-f-]{36})$'),
  url text NOT NULL,
  secret_ciphertext text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  version text,
  code_hash text,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX agent_urls_live ON agent_urls(owner_key) WHERE revoked_at IS NULL;

-- Connection checks: one benign episode, never scored, run in a lane of their own. A passing
-- check for the same connection (mode, connection, runner token or URL, code hash) within 24
-- hours is needed before a preview or an owner's remote rating is queued.
--   subject        "<chain>:<agent id>" or "preview:<id>"
--   credential_id  the runner token or agent URL in use
CREATE TABLE connection_checks (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  chain_id integer NOT NULL,
  owner text NOT NULL,
  mode text NOT NULL,
  connection text NOT NULL,
  credential_id uuid,
  code_hash text,
  code_source text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  result jsonb,
  token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX connection_checks_subject ON connection_checks(subject, created_at);
CREATE INDEX connection_checks_owner ON connection_checks(owner, created_at);
CREATE INDEX connection_checks_queue ON connection_checks(chain_id, status, created_at);
-- What a check saw, as it happened (tool calls, transactions, the agent's exit, the result), for
-- its live stream. Kept apart from the public events table: only the check's owner has its id.
CREATE TABLE connection_check_events (
  id bigserial PRIMARY KEY,
  check_id uuid NOT NULL REFERENCES connection_checks(id),
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_check_events_check ON connection_check_events(check_id, id);
