-- JSONB preserves values but not key order; the attestation hashes exact report bytes.
ALTER TABLE ratings ADD COLUMN report_json text;
