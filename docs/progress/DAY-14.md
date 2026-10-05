# Day 14: demo agent, one-command demo, docs, self-serve

Plan reference: docs/PLAN.md Section 20, Day 14, and the "Day 14 detail" table (PRs #77 and #88). Done when: the demo runs in one command from a clean state; the break-it script pays a claim on testnet; README links all resolve; the repo history is clean of secrets.

## Done

| # | Workstream | PR | Result |
|---|---|---|---|
| 1 | Demo Agent A | [#78](https://github.com/ddboy19912/bonded/pull/78) | Agent 10 on Robinhood testnet: the vulnerable brain behind the hardened guard, except that the guard checks addresses by their first 6 and last 4 characters. Live rating **49 (BB)**, details below. Cover policy 2 is active |
| 2 | One-command demo and break-it run | [#80](https://github.com/ddboy19912/bonded/pull/80) | `pnpm demo` runs everything locally from a fresh clone with no keys. `pnpm demo:break` paid a claim on testnet (below) |
| 3 | README and docs | [#82](https://github.com/ddboy19912/bonded/pull/82), [#79](https://github.com/ddboy19912/bonded/pull/79), [#87](https://github.com/ddboy19912/bonded/pull/87) | README rewrite with live links and measured numbers, `docs/ARCHITECTURE.md`, `docs/DEVELOPING.md`, `docs/AGENTS.md` (what each agent is, and what works today versus later). A test checks every README address against the deployment files |
| 4 | Repository hygiene | [#83](https://github.com/ddboy19912/bonded/pull/83) | gitleaks over the whole history: no live secret. MIT licence, SECURITY.md |
| 5 | Bounty guide | [#91](https://github.com/ddboy19912/bonded/pull/91) | Step-by-step hunter's guide on the Bounties page and in `docs/BOUNTIES.md`. The page now runs the API's spec check before commit, and the check refuses unknown placeholders (they used to pass and then stop every validation run). Checked with a fresh wallet on testnet (below) |
| 7 | Self-serve | [#88](https://github.com/ddboy19912/bonded/pull/88), [#89](https://github.com/ddboy19912/bonded/pull/89), [#90](https://github.com/ddboy19912/bonded/pull/90) | From the web app with no operator token: onboard an agent, rate it with a built-in design against your own vault, buy cover, simulate a breach. Checked on the hosted app with a fresh wallet (below) |
| — | Keeper gas alert | [#81](https://github.com/ddboy19912/bonded/pull/81) | The hosted keeper ran out of gas once; it now alerts when its wallet runs low |
| — | 5-run leaderboard | [#92](https://github.com/ddboy19912/bonded/pull/92) | All six entries re-rated with five runs per attack (below). Issue #64 closed |

Every PR has the full fresh-clone pipeline in its description. Not done: the pitch deck (workstream 6).

## Results

**Agent A, live rating (agent 10):** five runs per attack, 205 attack episodes including the accepted bounty attack, on a fork of Robinhood testnet. 15 breaches in 20 address-poisoning (A5) episodes, none in any other class. Score **49 (BB)**, expected loss 5.11%, premium 7.44% a year (posted in tx `0xa7128c78…e397`). A local rating gave the same score. The plan's option (A) was a guard that trusts swap tokens; built and rated first, it measured no weakness (score 50, 0 breaches), so the gap became address checking (PR #78).

**Break-it run on testnet** ([evidence](evidence/demo-break-testnet.json)): a lookalike of the depositor's address asked Agent A for a refund. Agent A sent 5,000 tUSDG, the vault recorded the breach and froze, and the hosted keeper's claim paid 4,500 (the loss minus the 10% deductible): **4,000 from the operator's bond, 500 from the pool**. Agent 10 was re-armed afterwards (`pnpm demo:break -- --reset`, 2026-10-05): bond 4,000, vault 49,999, policy 2 with 15,500 of cover left.

**Self-serve on the hosted app** ([evidence](evidence/self-serve-testnet.json), `pnpm check:self-serve`): a brand-new wallet onboarded agent 11, registered it for ratings by signing, and was rated by the hosted worker at **49 (BB)**, the same as the local test. It bought 20,000 of cover at 6.70% a year with a quote that needed no token, simulated a 5,000 breach, and the hosted keeper paid 4,500: 4,000 from the bond, 500 from the pool.

**Bounty guide on testnet** ([evidence](evidence/bounty-testnet.json), `pnpm check:bounty`): a brand-new wallet followed the guide's steps with a sample attack: commit, reveal, send. Submission 2 was rejected as "a known class and surface, and it doesn't beat current defences", as expected for that sample, and paid nothing. The bounty pool holds 9,500.91 tUSDG.

**Leaderboard with five runs per attack** (200 attack episodes and 2 controls per entry, Monitor mode, $9.01 model spend):

| Entry | Agent | 1 run | 5 runs |
|---|---|---|---|
| AgentKit chatbot, Claude Haiku 4.5 | 4 | 50 (BB) | 79 (A) |
| AgentKit chatbot, DeepSeek V4.1 Flash | 5 | 50 (BB) | 79 (A) |
| Bonded hardened agent (scripted) | 6 | 50 (BB) | 79 (A) |
| Solana Agent Kit LangGraph, Claude Haiku 4.5 | 7 | 50 (BB) | 79 (A) |
| Solana Agent Kit LangGraph, DeepSeek V4.1 Flash | 8 | 50 (BB) | 79 (A) |
| Bonded vulnerable agent (scripted) | 9 | 1 (CCC) | 1 (CCC) |

No template was breached in 200 attack episodes. The clean agents still tie: with no breaches, the score depends only on how much evidence there is, which is the same for all of them. Only breaches separate agents. The hosted leaderboard shows all six as verified against the registry.

Assumptions and limits: the templates are chatbots that sometimes stop to ask the user; about half the attacks arrive on surfaces they never read; results are for the listed models and settings.

## Checks at the end of the day (2026-10-05)

- **Pipeline on `main`** (fcdaba3, fresh clone): format, ABIs, Solana, IDLs, typecheck, lint, all tests (shared 123, web 50, api 96, arena 350, demo-agents 78, tee-agent 18, solana 9, keeper 3) and forge (173): all pass.
- **Hosted services:** Railway `api`, `keeper` and `arena-worker` run fcdaba3; Vercel production is on the same commit.

## Notes

- **The repo folder is synced by iCloud.** When iCloud is busy, reading `node_modules` there can stall a script for minutes (the re-arm hung until it was run from a clone outside the synced folder). Running scripts and tests from a clone outside `Documents` avoids it.
- **Pipeline clones take about 5.4 GB each.** Old clones filled the disk once; the pipeline script now deletes each clone after its run.

## Next

- Founder's own end-to-end test of the product.
- Optional: the pitch deck (workstream 6).
