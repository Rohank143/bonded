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

## Real deployment (2026-10-02)

- Image `ghcr.io/ddboy19912/bonded-tee-agent@sha256:e543f1b5…` (amd64, public), pinned in `services/tee-agent/docker-compose.yml`. The Docker build and a mock-mode run were tested on the founder's Mac.
- CVM `bonded-tee-agent` on Phala Cloud: `tdx.small`, dstack 0.5.9 production OS, app id `e4160e59…3a8338e`, compose hash `0x0205e838…32f9e19`. The first deploy used a dev OS image because the CLI picked up an SSH key; it was deleted and redeployed with `--no-dev-os`.
- The compose hash computed from Phala's manifest matches Phala's value and the one the hardware measured.
- Later review changes: the verifier refuses development OS images, treats malformed evidence as a failure, the quote API canonicalizes agent IDs and binds the vault's key, the HTTP service answers malformed request targets with 400, and the live-rating script keeps the token out of curl's arguments (see the PR).
- The Arena verified a real Intel TDX quote from it (TCB `UpToDate`). Two fixes came out of that, both in the verifier and its tests: the guest agent sends empty digests for runtime events, and Phala's API manifest has null fields the hash doesn't include. The evidence is saved as a test fixture.
- `arena rate --tee-url …` ran end to end against it: the rating (hardened-agent/scripted, score 83) carries the measurement `0xb933453b…8f01`, and the sandbox registry accepted the attestation.
- The API's agent config takes an optional `tee` entry; a rating job for such an agent verifies the live TEE first and fails if it doesn't. The deployed config has none: agent 2 is the Gate 1 demo vault, and TEE custody needs a vault run by the TEE's key (docs/TEE.md, step 7), so the live badge needs a separate demo agent, which `pnpm tee:seed` creates.

## Premium discount (added after the first deployment)

- The score has a **Key custody** group (ADR-014). Its numbers are labelled assumptions (λ = 0.02 a year, an operator-held key assumed stolen if the host is compromised, a verified-TEE key assumed safe), not Arena measurements. A verified TEE adds nothing to expected loss; an operator-held key adds λ · s.
- Scripted hardened agent, Enforce mode, 5 runs per seed: **93 (AAA), 1.48% premium** on an operator's server against **96 (AAA), 1.22%** in a verified TEE. The plan's demo numbers (96, 1.2%) are now the TEE case. With one run per seed: 80 (AA, 2.82%) against 83 (AA, 2.56%).
- Everything that doesn't pass `custody` is scored as before.

## Live checks (added after the first deployment)

- The keeper re-checks each TEE-hosted agent every ten minutes against the measurement in its on-chain score (ADR-013). Results are stored (`tee_checks`, migration 0004), served at `GET /agents/:id/tee` and shown on the profile as "TEE live check".
- A definite failure (`mismatch`, `invalid`) stops the API signing new cover quotes for that agent, and an outage doesn't clear it. An unreachable agent that has never failed is not blocked, so pausing the VM to save cost never locks the agent out of cover. New cover also needs the vault's execution key to be the TEE's key.
- `TeeUnavailableError` now separates "could not get the evidence" (a stopped VM, a gateway error, Intel's data not fetched) from "the evidence failed verification".

## Not done

- **The badge on the live testnet.** It needs a demo agent whose vault is run by the TEE's key and a rating job for it through the deployed API (docs/TEE.md, step 7). Nothing was posted to Robinhood testnet from here.
- **Existing cover is never voided by a failed check**, only new quotes are refused (ADR-013).
- **The Arena doesn't attack the live TEE agent.** It rates the code in its sandbox and verifies the live agent's proof. See ADR-012, decision 2.
- **The TEE service doesn't operate a vault**, and what it attests is the deployed identity service, not the rated implementation (ADR-012). The discount is only earned for a vault whose execution key is the TEE's key, enforced at quote time (ADR-013, ADR-014).
- **Ethereum Sepolia registry and 4-chain scores** were finished before Day 11 (the `multichain-scores` work) and are not part of this change.
