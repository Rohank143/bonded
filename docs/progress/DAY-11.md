# Day 11: TEE custody

Plan reference: docs/PLAN.md Section 20, Day 11, and Section 12. Decisions: [ADR-012](../decisions/012-tee-custody.md). Runbook: [docs/TEE.md](../TEE.md).

## Done

- `services/tee-agent`: the hardened agent's identity service for Phala dstack. It derives an EVM key and a Solana key inside the TEE and serves a fresh Intel TDX quote for each challenge. Quote report data commits to the code hash, both public keys and the caller's nonce. No route returns or uses a key.
- `verifyTeeEvidence` and `attestTeeAgent` in the Arena: quote verification against Intel's chain, report-data check, event-log replay to the RTMRs, compose-hash check, and the measurement. Any failure fails the rating. There is no fallback to an unmeasured score.
- `rateAgent` takes the verified TEE: the measurement goes into the signed attestation (and from there into every registry), the report records the TEE, and a TEE that runs different code than the one rated is refused.
- `arena rate --tee-url … --tee-compose-hash … --code-hash …`, and an optional `tee` entry in the API's agent config.
- Agent profile: a "Key custody" stat with a TEE badge, the measurement, and the session keys. The registry is the authority for the badge.
- Docker image, dstack compose file, a local mock mode and a compose-hash tool.

## Tests

- Shared: measurement and report-data helpers, the evidence schema.
- Arena: 15 unit tests that build a quote's facts and event log from the spec and try every way to break them (wrong nonce, wrong code, wrong keys, replay mismatch, forged compose-hash payload, missing or duplicated event, out-of-date platform, a garbage quote through the real verifier); 3 anvil tests that a rating posts the measurement to the registry and reads it back.
- Tee-agent: keys, the commitment sent to the hardware, a fresh quote each time, route rules, no private key in any response, no error detail leaked. Compose-hash tool.
- Web: when the badge and keys show.

## Not done

- **No real deployment yet.** It needs the Phala account and `phala` CLI on the founder's machine (docs/TEE.md). Until then, nothing here has seen a real TDX quote: the verifier is tested against facts built from the spec, and the Intel verifier is tested only on a garbage quote. The first deployment is the real test; docs/TEE.md step 6 says what to send me if the event digest rule needs a fix.
- **The Docker build is untested here.** Docker's daemon wasn't running on this Mac. The build's steps (install, build, `pnpm deploy`) were run by hand, and the bundle was started in mock mode and answered both routes.
- **No premium discount.** The actuarial model has no key-theft term, so the score is unchanged. See ADR-012.
- **The Arena doesn't attack the live TEE agent.** It rates the code in its sandbox and verifies the live agent's proof. See ADR-012, decision 2.
- **Ethereum Sepolia registry and 4-chain scores** were finished before Day 11 (the `multichain-scores` work) and are not part of this change.
