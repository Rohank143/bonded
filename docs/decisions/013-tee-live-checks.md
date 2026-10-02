# ADR-013: Live checks of TEE-hosted agents

- **Status:** Accepted
- **Date:** 2026-10-02
- **Code:** `apps/api/src/tee-watch.ts`, `packages/db/migrations/0004_tee_checks.sql`, `apps/arena/src/tee.ts`, `apps/web/src/lib/tee.ts`

## Context

ADR-012 proves a TEE deployment once, when the Arena rates the agent. The proof is a snapshot. If the operator later redeploys different code, or the VM is replaced, the score and badge would still say the old thing. The plan (Section 6) says a mismatch between the rated measurement and the running one must stop new cover.

## Decisions

### 1. The keeper checks every ten minutes

The `keeper` role challenges each enabled agent that has a `tee` entry in its config, using the same verification as a rating (`attestTeeAgent`). It compares the live measurement with the `teeMeasurement` in the agent's current on-chain score. The interval is `TEE_CHECK_MS` (default 600000, at least 60000). The latest result is stored in `tee_checks` and served at `GET /agents/:id/tee`.

### 2. Five outcomes, and only two of them block

| Status | Meaning | New quotes |
|---|---|---|
| `verified` | A fresh quote verifies and its measurement is the rated one | allowed |
| `unrated` | The quote verifies, but the score has no TEE measurement yet | allowed |
| `unreachable` | No answer, a gateway error, or Intel's data could not be fetched | allowed |
| `mismatch` | The quote verifies, but its measurement is not the rated one | **refused** |
| `invalid` | The evidence fails verification (bad quote, wrong code, wrong compose hash, wrong keys) | **refused** |

An unreachable agent does not block because it says nothing about what is running, and because the key never leaves the VM: a stopped or unreachable TEE cannot leak it. Blocking on it would let an outage, or a paused VM, lock an agent out of cover. Intel's data being unavailable is the same kind of non-answer, which is why `TeeUnavailableError` is separate from `TeeVerificationError`.

### 3. How "refused" works without a contract change

Cover is bound by an EIP-712 quote that this API signs. When the latest check for the agent is `mismatch` or `invalid`, `POST /quotes` answers 409 and signs nothing. The next `verified` check lifts it, or a re-rating with the new deployment does (the new score carries the new measurement). No contract or registry change is needed.

### 4. Existing cover is not touched

Cover already bound stays bound. The plan allows voiding existing cover in TEE mode, but that is a payout-affecting decision and belongs on-chain and deterministic, not in an off-chain check that can be wrong or unavailable. It is not built.

## Limits

- The check is only as often as the interval, and only for agents with a `tee` entry in the service config.
- `unreachable` for a long time is shown on the profile but never blocks. If an unreachable agent should lose cover after some time, that is a policy to decide.
- Phala's PCCS (collateral for Intel's verification) is a dependency. If it is down, checks are `unreachable` and nothing blocks.
