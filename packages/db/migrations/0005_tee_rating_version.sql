-- Bind custody evidence and failures to a rated report, including replacements with the same
-- measurement. Existing rows have no version proof; a rating or verified live check refreshes it.
ALTER TABLE tee_checks ADD COLUMN rated_report_hash text;
