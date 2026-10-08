-- Preserve old outcomes, with unknown path/cost metadata. Failed checks have no verdict.
ALTER TABLE sentinel_checks ALTER COLUMN manipulated DROP NOT NULL;
ALTER TABLE sentinel_checks ALTER COLUMN blocked DROP NOT NULL;
ALTER TABLE sentinel_checks ADD COLUMN status text NOT NULL DEFAULT 'success'
  CHECK (status IN ('success', 'error'));
ALTER TABLE sentinel_checks ADD COLUMN pipeline_hash text;
ALTER TABLE sentinel_checks ADD COLUMN model text;
ALTER TABLE sentinel_checks ADD COLUMN escalated boolean;
ALTER TABLE sentinel_checks ADD COLUMN primary_latency_ms integer;
ALTER TABLE sentinel_checks ADD COLUMN fallback_latency_ms integer;
ALTER TABLE sentinel_checks ADD COLUMN input_tokens bigint;
ALTER TABLE sentinel_checks ADD COLUMN output_tokens bigint;
ALTER TABLE sentinel_checks ADD COLUMN llm_cost_usd numeric;
ALTER TABLE sentinel_checks ADD CONSTRAINT sentinel_checks_verdict CHECK (
  (status='error' AND manipulated IS NULL AND blocked IS NULL) OR
  (status='success' AND manipulated IS NOT NULL AND blocked IS NOT NULL)
);
CREATE INDEX sentinel_checks_pipeline ON sentinel_checks(chain_id, pipeline_hash, checked_at);
