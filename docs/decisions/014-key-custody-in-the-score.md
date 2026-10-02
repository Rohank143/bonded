# ADR-014: Key custody in the score

- **Status:** Accepted
- **Date:** 2026-10-02
- **Code:** `packages/shared/src/actuarial.ts` (`KEY_CUSTODY_GROUP`, `ScoringInput.custody`), `apps/arena/src/rate.ts`

## Context

Plan Section 3 says every discount is earned in the Arena, and Section 12 says TEE custody removes the key-theft exposure. The score had no key-theft term, so a verified TEE changed nothing in the price. The Arena attacks agents through what they read (injection, poisoned data and so on). It can't measure what an attacker does after taking the agent's key from a compromised server, so this term can't be measured the way the others are.

## Decision

Add one risk group to the score, **Key custody (operator-server compromise)**, with numbers that are labelled assumptions in the code, the report and here:

| Input | Operator-held key | Key in a verified TEE |
|---|---|---|
| λ, chance the host is compromised per year | 0.02 (ours; the plan gives no figure) | 0.02 |
| b, chance the key is stolen given a compromise | 1 (assumed: the attacker signs whatever the mandate allows) | 0 (assumed: the key can't be extracted) |
| s, severity | the untested-group prior: 0.35, capped by the per-trade cap in Enforce mode | same |
| Added to expected loss | λ · b · s | 0 |

`rateAgent` passes `custody: "tee"` only when the TEE evidence verified, and `"operator"` otherwise. `scoreRating` without a `custody` argument leaves the term out, as before, so every earlier call and test is unchanged.

The discount reaches buyers without any other change: cover quotes are priced from the attestation's expected loss, so a TEE-verified rating gives a lower premium.

## Effect on the demo agents

Scripted hardened agent in Enforce mode, 5 runs per seed:

| | Score | Premium |
|---|---|---|
| Key on the operator's server | 93 (AAA) | 1.48% |
| Key in a verified TEE | 96 (AAA) | 1.22% |

With one run per seed: 80 (AA, 2.82%) against 83 (AA, 2.56%). The plan's worked example (96, 1.2%) is the TEE case. Scores already posted on-chain are not changed: they update when the agent is re-rated.

## Limits

- **λ is a guess.** It is one constant, `KEY_CUSTODY_GROUP.lambda`. Change it if there is better incident data; the effect scales with it. At 0.02 the whole TEE discount is about 0.2 percentage points of expected loss in Enforce mode and about 0.7 in Monitor mode.
- **b = 0 for a TEE is an assumption.** Hardware attacks on TDX, bugs in the agent code that leak the key, and trust in Phala and Intel are not modelled.
- **A stale TEE is not rated as one.** If the live check later fails (ADR-013), new quotes stop. The score already posted keeps its lower expected loss until it expires or is re-rated.
- Reports keep `version: 1`: the new group is an additional row, and the markdown report says in plain words that it is an assumption.
