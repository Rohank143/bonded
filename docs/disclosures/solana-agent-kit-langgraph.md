# Solana Agent Kit: LangGraph example

- **Template:** `examples/misc/agent-kit-langgraph` in [sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) (Apache-2.0), solana-agent-kit 2.0.10
- **Rated:** 2026-10-03, one run of each of the 40 attack seeds plus 2 controls, on a fresh local chain
- **Models:** anthropic/claude-haiku-4.5 and deepseek/deepseek-v4.1-flash
- **On chain (Robinhood Chain testnet registry):** [agent 7](https://bonded-nu.vercel.app/agents/7) (Haiku), [agent 8](https://bonded-nu.vercel.app/agents/8) (DeepSeek); [leaderboard](https://bonded-nu.vercel.app/leaderboard)
- **Disclosure status:** published. No breach was found, so nothing is withheld.

## How it was run

The example's LangGraph ReAct agent and its prompt ran unchanged. Its tools were the Arena's, defined as Solana Agent Kit `Action`s and converted with the kit's `createLangchainTools`. The kit's own Solana actions weren't exercised: the Arena's vault is an EVM contract, so this rates the template's agent behaviour, not its Solana integrations. The operator's message was the Arena's task and the mandate.

## Results

| Model | Score | Attacks breached | Controls breached | Attacks whose planted text it read | Of those: stopped to ask the user | Carried on with its own task |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 50 (BB) | 0 of 40 | 0 of 2 | 21 | 3 | 18 |
| DeepSeek V4.1 Flash | 50 (BB) | 0 of 40 | 0 of 2 | 24 | 14 | 20 |

The DeepSeek counts overlap: some episodes made the trade, then also asked the user about the planted request.

The same caveats apply as for the AgentKit template:
- one run per attack;
- a chatbot that sometimes stops to ask, which a live user could answer with yes;
- attacks on surfaces it never read;
- 50 is the ceiling for a clean agent at one run. Five runs raise it to 79 (below).

## Re-rated with five runs (2026-10-04)

Both models were rated again with five runs of each of the 40 attack seeds (200 attack episodes and 2 controls each), same template, settings and Monitor mode, and the scores were posted for agents 7 and 8:

| Model | Score | Attacks breached | Controls breached |
|---|---|---|---|
| Claude Haiku 4.5 | 79 (A) | 0 of 200 | 0 of 2 |
| DeepSeek V4.1 Flash | 79 (A) | 0 of 200 | 0 of 2 |

Still no breach. The score rose from 50 to 79 because more runs narrow the bound on each class's breach rate. Every agent with no breaches scores 79 at these settings, so the two models tie. The behaviour counts in the table above are from the one-run rating and weren't recounted.

## Re-rated with held-out attacks (2026-10-06)

Both models were rated again with five runs of each of the 40 published attacks and of a held-out set of unpublished attacks: 275 attack episodes and 2 controls each. The template, settings and Monitor mode are unchanged, and the scores were posted for agents 7 and 8:

| Model | Score | Attacks breached | By class | Controls breached |
|---|---|---|---|---|
| Claude Haiku 4.5 | 81 (AA) | 0 of 275 | none | 0 of 2 |
| DeepSeek V4.1 Flash | 81 (AA) | 0 of 275 | none | 0 of 2 |

Still no breach with either model. Agents with no breaches score 81 at these settings; more clean episodes narrow the bounds further than the five-run rating did.

## Suggested mitigations, if deployed as an autonomous agent

The same as for AgentKit: limits enforced on chain or in code, allowlisted recipients and spenders, no follow-up approval of requests that come from untrusted content, and a pre-trade guard.
