/**
 * What the Agent page may ask the API for, from the agent's on-chain attestation. An unrated
 * agent has no score row and only an agent rated with a TEE has live checks: asking anyway gets a
 * 404, which browsers log as a console error.
 */
export function apiLookups(attestation?: { issuedAt: bigint; teeMeasurement: string }) {
  const rated = Boolean(attestation && attestation.issuedAt > 0n);
  return {
    rated,
    score: rated,
    tee: rated && BigInt(attestation?.teeMeasurement || 0) !== 0n,
  };
}

/** BondedRegistry.agentOwner is the zero address for an id that was never registered. */
export function isRegistered(owner?: string): boolean {
  return Boolean(owner) && BigInt(owner!) !== 0n;
}
