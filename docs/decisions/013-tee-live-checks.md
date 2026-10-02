# ADR-013: Live checks of TEE-hosted agents

- **Status:** Accepted
- **Date:** 2026-10-02
- **Code:** `apps/api/src/tee-watch.ts`, `packages/db/migrations/0004_tee_checks.sql`, `apps/arena/src/tee.ts`, `apps/web/src/lib/tee.ts`

## Context

ADR-012 proves a TEE deployment once, when the Arena rates the agent. The proof is a snapshot. If the operator later redeploys different code, or the VM is replaced, the score and badge would still say the old thing. The plan (Section 6) says a mismatch between the rated measurement and the running one must stop new cover.

## Decisions

### 1. The keeper checks every ten minutes

The `keeper` role challenges each enabled agent that has a `tee` entry in its config, using the same verification as a rating (`attestTeeAgent`). It compares the live measurement with the `teeMeasurement` in the agent's current on-chain score. The interval is `TEE_CHECK_MS` (default 600000, at least 60000). The latest result is stored in `tee_checks` and served at `GET /agents/:id/tee`.

### 2. Five outcomes, and a definite failure is remembered

| Status | Meaning |
|---|---|
| `verified` | A fresh quote verifies, its measurement is the rated one, and its key is the one recorded for the rating |
| `unrated` | The quote verifies, but the score has no TEE measurement yet |
| `unreachable` | No answer, a gateway error, or Intel's data could not be fetched |
| `mismatch` | The quote verifies, but its measurement or key is not the rated one |
| `invalid` | The evidence fails verification, or anything else goes wrong processing it (bad quote, malformed log, wrong code or compose hash, unapproved OS image, wrong keys) |

`mismatch` and `invalid` are **definite failures**. They set a separate `blocking_status`. That field is cleared only by a later `verified` or `unrated` check, or by a replacement rating (decision 4). An `unreachable` check never sets it and never clears it, so an outage can't reopen quote issuance after a failure, and a stopped VM can't lock out an agent that has never failed. An `unreachable` agent can't leak a key (the key never leaves the VM), which is why it doesn't block. Intel's data being unavailable is the same kind of non-answer, which is why `TeeUnavailableError` is separate from `TeeVerificationError`. Errors that aren't `TeeUnavailableError` are failures, not outages: a hostile agent must not be able to make itself "unreachable".

### 3. What stops a quote, without a contract change

Cover is bound by an EIP-712 quote that this API signs. For an agent whose current score carries a TEE measurement, `POST /quotes` answers 409 and signs nothing unless:

1. the TEE's key is on record for **this** score (recorded when the rating was posted, or by a verified check). A row made against an older score counts as no row;
2. **the vault's execution key (`vault.agent()`) is that key.** Otherwise the vault is not protected by the TEE and the discount in ADR-014 is unearned. This also catches a later key rotation, for new cover;
3. no definite failure is outstanding for this score.

Agent IDs are canonicalized before any lookup (`01` and `1` are the same agent). For an agent with no TEE measurement none of this applies.

### 4. When a block is lifted

- A later check passes (`verified` or `unrated`).
- A replacement rating is posted: the worker records the new score's key and measurement and clears the block, or deletes the row if the new rating has no TEE (a move back to operator custody).
- The agent's `tee` entry is removed from the config: the next keeper pass deletes the row.

### 5. Existing cover is not touched

Cover already bound stays bound. The plan allows voiding existing cover in TEE mode, but that is a payout-affecting decision and belongs on-chain and deterministic, not in an off-chain check that can be wrong or unavailable. A key rotation after cover is bound is therefore only caught for new cover. It is not built.

## Limits

- The check is only as often as the interval, and only for agents with a `tee` entry in the service config.
- `unreachable` for a long time is shown on the profile but never blocks on its own. If an unreachable agent should lose cover after some time, that is a policy to decide.
- Phala's PCCS (collateral for Intel's verification) is a dependency. If it is down, checks are `unreachable` and nothing blocks.
