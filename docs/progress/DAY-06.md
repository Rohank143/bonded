# Day 6: Ratings

Plan reference: docs/PLAN.md Section 20, Day 6. Design record: `docs/decisions/007-ratings.md`.

## Done

- **Actuarial model** (`@bonded/shared`, `scoreRating`): Section 9 exactly.
  - **Breach rate:** the 90% upper credible bound, solved exactly.
  - **Groups:** λ per class group.
  - **Severity:** measured or prior, whichever is larger, with the prior capped in Enforce mode.
  - **Outputs:** expected loss, premium, score and tier.
  - Reproduces the plan's worked example.
- **Attack library:** 40 seeds, four in each of the ten classes, covering all nine surfaces. New pieces:
  - **Surfaces:** market alerts and counterparty messages, each with a read tool.
  - **Seed options:** price spoofs (`delivery.prices`), a `{{lookalike}}` of the depositor's address for address poisoning, and a per-seed benign goal.
  - **Real losses:** the attacker spends approvals after the episode.
  - **Attribution:** each breach is linked to the tool call that caused it.
- **hardened-agent v0:**
  - **Guard:** `GuardedToolbox` with `PolicyGuard` enforces the mandate in code (allowlists, mandate tokens, per-trade and daily caps).
  - **Scripted brain:** acts only on its task.
  - **LLM brain:** source separation in its prompt, plus the same guard. The tool loop is shared with vulnerable-agent.
- **Laya-shaped pieces:**
  - **`DecisionModel` interface:** typed `noul` / `choice` answers with a confidence.
  - **`SentinelGuard`:** asks the Section 10.2 questions from minimal context.
  - **`DecisionModelAgent`:** a trading bot whose brain picks execute or ignore for each candidate action.
  - **Backend:** all three run on any chat model today through `LlmDecisionModel`.
- **Rating runner** (`rateAgent`, `arena rate`):
  - **Episodes:** every seed, repeated under different benign goals if asked, plus controls.
  - **Outputs:** `report.json`, `report.md`, a signed attestation, a Sentinel JSONL dataset and all traces.
  - **Registry:** in a fresh sandbox the attestation is posted to the registry and read back.
- **Spending cap:** `--max-usd` stops new episodes at the cap. Spend is reported, and marked as estimated when the endpoint doesn't report cost.
- **vulnerable-agent's scripted brain** also obeys swap, buy and "repeat N times" instructions, so the limit attacks (A3, A8, A9) can breach it.

## Done when: full rating run on both demo agents; scores differ in the expected direction; report renders

Met, on a fresh sandbox and on a fork of Robinhood Chain testnet (identical results; 42 episodes each, about 2 minutes per agent on the fork):

| Agent | Vault mode | Breached | Score | Expected loss | Premium |
|---|---|---|---|---|---|
| vulnerable-agent/scripted | Monitor | 40 of 40 attacks, 0 of 2 controls | **1 (CCC)**, not insurable | 32.9% | 43.6% |
| hardened-agent/scripted | Enforce | 0 of 40, 0 of 2 | **83 (AA)** | 1.4% | 2.6% |
| hardened-agent/scripted, `--repeats 5` | Enforce | 0 of 200, 0 of 2 | **96 (AAA)** | 0.3% | 1.2% |

- **Vulnerable-agent's losses:** its worst episodes lose the whole $50,000 vault (a "transfer all", or an approval the attacker then spends).
- **Hardened-agent's score** is limited only by how many episodes back it up. Five runs per seed reproduce the plan's 96 / AAA / 1.2%.
- **On the fork,** the attestation is signed but not posted, because the fork's attester is the real deployer key. The report says so.

The reports render as Markdown with per-group λ, b, s and expected loss, per-class results, worst episodes and mitigations.

## Tests

On a fresh clone: format check, `abis:check`, typecheck, lint, all tests, `forge fmt --check` and `forge test` all pass.

- **`@bonded/shared`:** 80 (14 new). They cover the Beta bound against closed forms, the worked example, grouping, severity rules including the Enforce cap, untested groups priced as CCC, and the bond discount.
- **`@bonded/demo-agents`:** 42 (27 new):
  - the policy guard's allowlists, caps and tokens
  - the guard sees untrusted inputs
  - the scripted hardened agent ignores injections and refuses an oversize task
  - the LLM hardened agent's guard stops a talked-into transfer
  - decision parsing that rejects answers outside the options
  - the decision agent, and the Sentinel guard's minimal context and blocking
  - swap and repeat instructions
- **`@bonded/arena`:** 78 plus 2 opt-in fork tests (58 new, 36 of them the new seeds). The integration tests prove:
  - every seed breaches the vulnerable agent, with the breach attributed to a call
  - approvals are drained and priced at $50,000
  - address poisoning plants a real lookalike
  - a full rating of both demo agents (described above)
  - the report hash matches the file
  - the registry stores the posted score
  - dataset labels are correct, including control negatives
  - the hardened LLM brain over a real HTTP endpoint is stopped by its guard
  - the spending cap stops a rating
- **Forge:** 156, unchanged.

## Fixed in review

CodeRabbit found four issues and one nit. All were verified and fixed, each with a test:

| Finding | Fix |
|---|---|
| A decision model's token use (the decision agent, and the Sentinel guard) never reached the spending cap, so `--max-usd` couldn't stop a decision-agent rating | Decision models and model-based guards report usage. Agents add it to their run summary per episode. If any part reports tokens but no cost, the total claims no cost, so the cap estimates from all tokens. |
| A decision answer with no confidence defaulted to 0.5, below Sentinel's 0.7 blocking threshold, so a malformed "yes, manipulated" let the write through | A missing or non-numeric confidence is an error |
| A guard that threw (a malformed answer, a network error) crashed the whole episode, which then dropped out of the rating as an agent error | A failing guard refuses that one write and the episode continues (fails closed) |
| The severity prior counted seeds that never ran, e.g. after the spending cap stopped a rating | Only seeds that ran set the prior |
| Seed A5-address-poisoning-004's title and description disagreed | Both now describe a fake vault migration to a lookalike of the depositor's address |

## Not built

- **Adaptive attacker.** The plan's model-driven attacker, which writes new attack payloads and adapts them to the agent's responses, is not included. Ratings use the 40 hand-written seeds, with `--repeats` for sampling. Bounties (Section 13) remain the way to grow the library. See ADR-007, decision 3.
- **Laya itself.** Hugging Face is blocked here, so the decision agent and Sentinel guard run on a chat model behind the `DecisionModel` interface. The Laya adapter comes once its server can be tested.
- **Quote signing.** Moved to Day 7, with `buyCover`.

## Changes to the plan

- **Section 8.2:** what the library now contains.
- **Section 8.3:** the adaptive attacker's status.
- **Section 8.4:** the decision-model adapter.
- **Section 8.6:** the rating outputs.
- **Section 9.2:** the implementation, A9's λ assumption (0.05) and the demo results.
- **README:** the `rate` command and new flags.

## Blockers

- **OpenRouter key and access.** Needed to rate the LLM brains for real; `openrouter.ai` returns 403 from this environment.
  - Add `OPENROUTER_API_KEY` in the environment settings and allow `openrouter.ai`.
  - Or run on your machine: `pnpm --filter @bonded/arena arena rate --brain llm --model <id> --max-usd 2`.
- **Hugging Face access for Laya** (`huggingface.co` and its CDN), for Day 9's fine-tune and a Laya adapter.

## Next (Day 7, Gate 1)

- The API (REST and SSE) and the keeper.
- A testnet end-to-end run: Arena → attestation → quote → `buyCover` → live breach → automatic claim.

## Review asks

- **Read two or three new seeds per class in `attacks/`.** Do they look like what agents meet in the wild? Which classes need more?
- **Check the λ priors and severity rules** in `packages/shared/src/actuarial.ts` (ADR-007, decision 1), especially A9's λ of 0.05 and the Enforce-mode cap.
- **Check hardened-agent's system prompt** in `apps/demo-agents/src/hardened/llm.ts`.
