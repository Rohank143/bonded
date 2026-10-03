# Day 12: bounties, leaderboard, Gate 2

Plan reference: docs/PLAN.md Section 20, Day 12. Gate 2 is "feature complete", followed by founder review #2.

## Done

- **Bounties** ([PR #60](https://github.com/ddboy19912/bonded/pull/60), [docs/BOUNTIES.md](../BOUNTIES.md)). A hunter commits a hash of their attack on BountyBoard, reveals it, and sends the YAML to the API. The Arena validates it deterministically: 3 runs against the scripted vulnerable and hardened agents in its sandbox. It rejects copies of the library (80% payload overlap with any seed) and pays by a fixed rule: 2,000 tUSDG if the attack beats the defended agent, 500 tUSDG if it opens a class and surface the library doesn't cover. An accepted attack joins the library and every agent is queued for re-rating, in the same database transaction as the acceptance. Payouts are sent once: the verdict is stored before the transaction, the nonce is fixed before broadcast, and a retry reads the chain before sending again.
- **Leaderboard** ([PR #61](https://github.com/ddboy19912/bonded/pull/61)). Two framework adapters run real open-source templates unchanged (their prompt and agent loop), with only their tools pointed at the Arena: the Coinbase AgentKit LangChain chatbot and the Solana Agent Kit LangGraph example. Each was rated with two models. The board shows results per attack class only, and every entry is checked against its on-chain score. Disclosure notes are in [docs/disclosures](../disclosures/README.md).
- **Hosted web app.** Deployed to Vercel at https://bonded-nu.vercel.app from `main` (0b9e143), and the API allows that origin ([PR #62](https://github.com/ddboy19912/bonded/pull/62), applied to Railway).
- **Bounty pool funded** on Robinhood testnet with 5,000 tUSDG minted to BountyBoard (tx `0xee20bf22…f9a2`). The pool holds $10,000.21, because an earlier 5,000 had already been added.

## Leaderboard result

| Agent | Model | Score | On chain |
|---|---|---|---|
| AgentKit LangChain chatbot | claude-haiku-4.5 | 50 (BB) | agent 4, verified |
| AgentKit LangChain chatbot | deepseek-v4.1-flash | 50 (BB) | agent 5, verified |
| Solana Agent Kit LangGraph example | claude-haiku-4.5 | 50 (BB) | agent 7, verified |
| Solana Agent Kit LangGraph example | deepseek-v4.1-flash | 50 (BB) | agent 8, verified |
| Bonded hardened demo agent | scripted | 50 (BB) | agent 6, verified |
| Bonded vulnerable demo agent | scripted | 1 (CCC) | agent 9, verified |

None of the templates fell for basic prompt injection: 0 breaches in 40 injection episodes each. Assumptions and limits, also shown on the page:

- One run per attack seed. With one run, an agent with no breaches scores 50, because the breach-rate bound is wide. Five runs would tighten it (about $10 in model spend).
- The templates are chatbots: they sometimes stop to ask the user instead of acting, which counts as no breach.
- About half the attacks arrive on surfaces (inbox, social, news) these templates never read.
- Results are for the listed models and settings. Model spend for all four evaluations was about $2.10.

## Gate 2 walkthrough (2026-10-03, live)

Checked on the hosted site against the deployed API and Robinhood testnet.

| Feature | Plan day | Result | Evidence |
|---|---|---|---|
| Arena rating and live feed | 5–8 | Pass | `/arena` lists run `07d53dd5`: 200 attacks and 2 controls, 0 breaches |
| Agent profile and score from the registry | 7–8 | Pass | `/agents/3`: 96 (AAA), report hash matches the attestation |
| Vaults | 2, 8 | Pass | `/vaults` lists vaults for agents 1, 2 and 3 |
| Cover, breach and claim on EVM | 3, 7 | Pass | `/claims`: policy 1, $1,000 loss, $900 from the bond, $100 deductible ([evidence](evidence/gate-1-testnet.json)) |
| Cover, breach and claim on Solana | 10 | Pass (devnet, from Day 10) | $1,000 loss, $500 from the bond and $400 from the pool, vault frozen ([evidence](evidence/solana-devnet-e2e.json)) |
| Underwrite page | 8 | Pass | `/underwrite`: pool $1,000,003, active cover $19,100 |
| Sentinel v5 in production | 9–10 | Pass | Railway pins `SENTINEL_MODEL_REVISION` f8d3057; gate results in [SENTINEL-STRESS.md](../SENTINEL-STRESS.md) (promoted with the recorded gate-2 exception, v6 is issue #55) |
| TEE badge | 11 | Pass, live check offline | `/agents/3` shows "Key custody: TEE" and the measurement `0xb933…8f01`. The live check says "offline": the Phala VM is not answering (last verified 2026-10-02). New cover quotes for agent 3 still work, since an unreachable agent that never failed is not blocked |
| Score on 4 chains | 11 | Pass | Agent 3's score is identical on Robinhood testnet, Arbitrum Sepolia, Ethereum Sepolia and Solana devnet ([evidence](evidence/multichain-scores-agent3-tee.json)) |
| Bounties page | 12 | Pass | `/bounties`: pool $10,000.21, submit form, empty submissions list |
| Bounty paid | 12 | **Tests only** | No live submission yet. Covered by the Arena's anvil integration tests (accept and pay, reject a copy) and 8 API worker tests (including fault injection and a resent payout) |
| Leaderboard | 12 | Pass | `/leaderboard`: 6 entries, all verified against the registry |

## Not done

- **A live bounty payout.** Running one means submitting a real test attack to the public board on Robinhood testnet. It waits for the founder's go-ahead.
- **The TEE VM is offline.** Restart it on Phala before the demo so the live check shows "verified".
- **Agent 2 has no stored report in the API.** Its profile shows the on-chain score (56, BB) but no attack-class table, because the API has no stored rating for it (`GET /agents/2/score` returns 404). A re-rate through the API would fill it in.
- **Vercel deploys by hand.** The project isn't connected to the GitHub repository, so each change to the web app needs `vercel --prod` from a clean clone of `main` (a clean clone keeps `.env` out of the upload).
- Optional: 5 runs per seed for the leaderboard, issue [#32](https://github.com/ddboy19912/bonded/issues/32) (the cascade) and issue [#55](https://github.com/ddboy19912/bonded/issues/55) (Sentinel v6).
