# ADR-012: TEE key custody

- **Status:** Accepted
- **Date:** 2026-10-01
- **Code:** `packages/shared/src/tee.ts`, `apps/arena/src/tee.ts`, `services/tee-agent/`, `apps/web/src/lib/tee.ts`
- **Runbook:** `docs/TEE.md`

## Context

Plan Section 12 (Day 11): run the hardened agent in a TEE so the rating can say two things the operator can't fake: the code that is running is the code we rated, and nobody, including the operator, can extract the agent's key. The attestation already has a `teeMeasurement` field (zero until now), the registry stores it, and the cross-chain posting copies it. This ADR covers how the field gets a real value.

## Decisions

### 1. Phala Cloud dstack on Intel TDX

An Intel TDX confidential VM, run by Phala Cloud's dstack. The agent's container runs in the VM. The guest agent inside the VM, reachable over a Unix socket, does two things for us: it derives keys that never leave the VM, and it asks the CPU for a signed quote. We pin `@phala/dstack-sdk` 0.5.8, which uses `getKey(path, purpose, algorithm)` and `getQuote(reportData)` and works on dstack OS 0.5.7 and later (ed25519 needs 0.5.7).

### 2. The Arena rates the code. The TEE proves that code is what runs.

The Arena still attacks the hardened agent in its own sandbox, as before. The live TEE agent is not attacked over the network. It serves identity only: its session keys and a quote. That is enough for the two claims above, and it keeps a remote agent protocol (a large piece of work that nothing in the badge needs) out of Day 11. If we later want the Arena to attack the deployed agent, the evidence format doesn't change.

### 3. What the quote commits to

The agent asks for a quote whose 32-byte report data is

`keccak256("bonded-tee-v1" || codeHash || evmAddress || solanaPublicKey || nonce)`

- `codeHash`: the hash the Arena rates. It is baked into the image at build time (`--build-arg CODE_HASH`), and the image's digest is in the compose file, so the hardware's measurement covers it.
- both public keys: binds the keys to this code in this machine.
- `nonce`: a fresh random value from the Arena on every request, so an old quote can't be replayed.

### 4. What the Arena checks (`verifyTeeEvidence`)

Nothing the agent says is trusted. The Arena throws, and the rating fails, unless all of these hold:

1. The quote verifies against Intel's certificate chain (`@phala/dcap-qvl`, collateral through Phala's PCCS) and Intel's TCB status for the machine is `UpToDate` or `SWHardeningNeeded`.
2. The quote's report data equals the commitment in decision 3, recomputed by the Arena.
3. The event log replays to the quote's RTMR0 to RTMR3 (`new = sha384(old || digest)`). dstack's guest agent leaves `digest` empty for runtime events (the RTMR3 ones), so for those the Arena computes it as `sha384(type (u32 LE) ":" event ":" payload)`. The replay must then reach the quote's RTMR3, so the hardware binds each event's name and payload.
4. The log has exactly one `compose-hash` event and its payload equals the compose hash the operator published for this deployment.
5. The evidence's `codeHash` equals the code being rated.

There is no fallback. A configured TEE that doesn't verify fails the rating job. It never quietly produces an unmeasured score.

### 5. The measurement

`teeMeasurement = keccak256(MRTD || RTMR0 || RTMR1 || RTMR2 || composeHash)`.

MRTD and RTMR0 to RTMR2 fix the virtual firmware, kernel and OS image. RTMR3 is left out because it also records per-instance events (instance id, boot time), which would give two copies of the same app different measurements. The compose hash, which RTMR3 does contain and which check 4 verified, is included directly. A swapped OS image, a changed compose file or a different image digest each change the measurement.

### 6. Keys

Derived by `getKey` from the app's identity: the same compose hash gets the same keys after a restart, and no other app can derive them. One secp256k1 key for EVM chains and one ed25519 key for Solana, under fixed paths (`bonded/agent/v1`). The private keys exist only inside the agent's process. The service has no route that returns or uses a key.

### 7. Where it shows up

- The registry on every chain already carries `teeMeasurement` from the attestation. The agent profile shows the "TEE" badge when the on-chain value is non-zero, so the registry is the authority, not the report.
- The report records the measurement, compose hash, session keys and TCB status. The profile shows the keys only when the report's measurement equals the on-chain one.
- Operators provision a TEE in the agent's config: `tee: { url, composeHash }`. Callers of the API can't choose it.

## Not done, and limits

- **The premium discount** is ADR-014: a labelled assumed key-custody term in the score, which a verified TEE zeroes.
- **On-chain quote verification** (the plan's stretch goal) is not built. The Arena verifies off-chain and the attester signs the result.
- **Trust in the attester.** The chain trusts the Arena's attester to have verified the quote. Intel and the measurement are trusted for the TEE claims, and the attester is trusted to have checked them.
- **Verified on real hardware.** On 2026-10-02 a real quote from a Phala Cloud TDX VM (dstack 0.5.9, production OS, Intel TCB `UpToDate`) passed every check above, and a rating with it posted a real measurement. The captured evidence is a regression test. This confirms the digest rule, which the first version had assumed.
- **Live re-checking** is ADR-013. The proof is no longer only a snapshot.
- **Dev OS images are not rejected.** A dev image allows SSH into the VM, which defeats key custody. Today the runbook says to deploy with `--no-dev-os`. The OS image hash is in the quote's measurements, so the Arena could pin the allowed production image hash. That is future work, and until then the badge depends on the operator following the runbook.
- **The simulator.** dstack's simulator signs with a fixed development key, so its quotes can't pass Intel verification. The Arena only accepts real quotes, and `TEE_BACKEND=mock` can never earn a badge.
