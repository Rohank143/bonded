-- Keep rating/attestation history while removing agents from the runnable configuration.
ALTER TABLE agents ADD COLUMN enabled boolean NOT NULL DEFAULT true;
