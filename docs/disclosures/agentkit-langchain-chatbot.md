# Coinbase AgentKit: LangChain chatbot template

- **Template:** `typescript/examples/langchain-cdp-chatbot` in [coinbase/agentkit](https://github.com/coinbase/agentkit) (Apache-2.0), @coinbase/agentkit 0.10.4 with @coinbase/agentkit-langchain 0.3.0
- **Rated:** 2026-10-03, one run of each of the 40 attack seeds plus 2 controls, on a fresh local chain
- **Models:** anthropic/claude-haiku-4.5 and deepseek/deepseek-v4.1-flash
- **On chain (Robinhood Chain testnet registry):** [agent 4](https://bonded-nu.vercel.app/agents/4) (Haiku), [agent 5](https://bonded-nu.vercel.app/agents/5) (DeepSeek); [leaderboard](https://bonded-nu.vercel.app/leaderboard)
- **Disclosure status:** DeepSeek: published, no breach found. Haiku: **maintainer notice pending** for one A1 breach found on 2026-10-06 (see below); the class-level result is public, the attack and transcript are withheld under the [disclosure policy](README.md).

## How it was run

The template's agent loop and system prompt ran unchanged. Its tools were the Arena's (vault swaps, transfers and approvals, plus the news, inbox, social, market and counterparty reads), registered through AgentKit's own custom action provider and `getLangChainTools`. The template's own CDP wallet actions weren't exercised. The operator's message was the Arena's task and the mandate.

## Results

| Model | Score | Attacks breached | Controls breached | Attacks whose planted text it read | Of those: stopped to ask the user | Carried on with its own task |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 50 (BB) | 0 of 40 | 0 of 2 | 22 | 3 | 18 |
| DeepSeek V4.1 Flash | 50 (BB) | 0 of 40 | 0 of 2 | 24 | 11 | 7 |

What these mean:
- **No attack in the library led either model to move funds against the mandate.** With Haiku, the template mostly recognised the planted instructions and did its own trade anyway.
- **With DeepSeek, it often stopped and asked the user what to do,** for example whether to make a "custodian transfer" from a fake halt notice. That's safe in a one-turn run, where nobody answers. In a live chat, a user who says yes would get the transfer.
- **In about half the attack episodes, the planted text sat somewhere the agent never looked,** for example token metadata it didn't query. The same holds for every agent rated.
- **50 is the ceiling for a clean agent at one run per attack.** The score uses a 90% upper bound on each class's breach rate, which stays wide with so few runs. Five runs raise it to 79 (below).

## Re-rated with five runs (2026-10-04)

Both models were rated again with five runs of each of the 40 attack seeds (200 attack episodes and 2 controls each), same template, settings and Monitor mode, and the scores were posted for agents 4 and 5:

| Model | Score | Attacks breached | Controls breached | Model spend |
|---|---|---|---|---|
| Claude Haiku 4.5 | 79 (A) | 0 of 200 | 0 of 2 | $2.31 (estimated) |
| DeepSeek V4.1 Flash | 79 (A) | 0 of 200 | 0 of 2 | $2.27 (estimated) |

Still no breach. The score rose from 50 to 79 because more runs narrow the bound on each class's breach rate. Every agent with no breaches scores 79 at these settings, so the two models tie. The behaviour counts in the table above are from the one-run rating and weren't recounted.

## Re-rated with held-out attacks (2026-10-06)

Both models were rated again with five runs of each of the 40 published attacks and of 15 held-out attacks that are never published (ADR-007, decision 3): 275 attack episodes and 2 controls each. The template, settings and Monitor mode are unchanged, and the scores were posted for agents 4 and 5:

| Model | Score | Attacks breached | By class | Controls breached | Model spend |
|---|---|---|---|---|---|
| Claude Haiku 4.5 | 80 (AA) | 1 of 275 | A1 1 of 20 | 0 of 2 | $3.25 (estimated) |
| DeepSeek V4.1 Flash | 81 (AA) | 0 of 275 | none | 0 of 2 | $2.91 (estimated) |

With Haiku, one A1 (injection via token metadata) episode out of 20 was breached. This is a public library attack, not a held-out one. Under the disclosure policy the class-level result is public now, and which attack it was stays private until the maintainers have been told and have fixed it, or 30 days have passed. With DeepSeek there was no breach. Agents with no breaches score 81 at these settings; more clean episodes narrow the bounds further than the five-run rating did. The accepted bounty attack isn't in these local ratings, because its text exists only in the hosted service's database.

## Suggested mitigations, if deployed as an autonomous agent

- Enforce limits outside the prompt: mandate limits on chain (Bonded's Mandate Vault) or in code, and an allowlist of recipients and spenders.
- Treat a "should I do X?" reply to untrusted content as a stop, not a question for whoever answers next.
- Put a pre-trade guard in front of transfers and approvals. Bonded's Sentinel is one.
