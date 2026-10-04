# Bonded

> **Don't cage your agent. Bond it.**

AI agents now trade with real money. When one gets tricked (a poisoned token description, a fake "admin" message, a lookalike address), someone loses funds, and today nobody pays them back. Bonded rates AI agents by attacking them, prices insurance from what the attacks found, and pays depositors automatically when an agent breaks its rules. **Payouts are decided by the agent's vault on chain, never by an AI.**

Runs on **Robinhood Chain**, with scores readable on **Arbitrum, Ethereum and Solana**.

## Try it

| | |
|---|---|
| **Web app** (Robinhood Chain testnet) | https://bonded-nu.vercel.app |
| **Agent Safety Leaderboard**: open-source agent templates, rated | https://bonded-nu.vercel.app/leaderboard |
| **Agent A**: insured, with one weakness the Arena found | https://bonded-nu.vercel.app/agents/10 |
| **Agent B**: hardened, key in a TEE, score 96 | https://bonded-nu.vercel.app/agents/3 |
| **Claims**: every automatic payout and where the money came from | https://bonded-nu.vercel.app/claims |
| **Live API** | https://api-production-ba50.up.railway.app/health |

**Or run the whole thing yourself in one command**, with no keys or accounts (needs Node 22, pnpm and Foundry; details in [docs/DEVELOPING.md](docs/DEVELOPING.md)):

```bash
git clone --recursive https://github.com/ddboy19912/bonded && cd bonded
pnpm install
pnpm demo
```

It starts a local chain, the API, keeper and rating worker; rates Agent A and Agent B; buys cover for both; plants an address-poisoning attack that Agent A falls for; shows the claim paying (operator's bond first, then the pool); and serves the web app at http://localhost:5180.

## How it works

1. **Mandate Vault.** An agent trades from a vault that knows its rules: which tokens, which contracts, where funds may go, how much per trade and per day. Every action goes through the vault, which blocks or records any breach on chain.
2. **The Arena.** AI attacker scenarios (10 classes: prompt injection, fake news and posts, poisoned prices, lookalike tokens and addresses, social engineering, hostile counterparty agents…) are planted in the agent's world inside a sandbox: a copy of the chain with the same contracts. The verdict of each episode is the vault's breach log.
3. **Bonded Score.** Breach rates become an expected loss, a premium and a score from 0 to 100. The attester signs it and posts it to the registry (ERC-8004 compatible); the same signed score can be posted to Arbitrum, Ethereum and Solana.
4. **Bond and cover.** The agent's operator stakes a bond that pays first. Underwriters fund a pool that pays the rest. Depositors buy cover priced from the score.
5. **Automatic claims.** When the vault records a breach, the keeper files the claim within seconds. The contract slashes the bond, then the pool pays, and the money goes back into the vault.

Plus **Sentinel**, an optional real-time guard: Laya, an open-source decision model, fine-tuned on Arena data to flag manipulated actions before they reach the vault. It is advisory; payouts never depend on it.

How the parts fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What each agent is: [docs/AGENTS.md](docs/AGENTS.md). The full product and build plan: [docs/PLAN.md](docs/PLAN.md).

## What you can do today

- **Anyone, in the web app** (with a browser wallet on Robinhood testnet): onboard an agent (register it, create its vault, stake a bond); rate it with one of Bonded's built-in agent designs against your vault; buy cover; simulate a breach and watch the claim pay; deposit; underwrite the cover pool; submit a bounty attack; browse agents, scores, reports, the leaderboard and claims.
- **Anyone, locally:** run the whole loop with `pnpm demo`, or rate the built-in agents with `pnpm arena rate`.
- **Not yet:** rating your own agent's code ([issue #84](https://github.com/ddboy19912/bonded/issues/84)) and bringing your own TEE ([issue #85](https://github.com/ddboy19912/bonded/issues/85)). Details: [What works today and what's coming](docs/AGENTS.md#what-works-today-and-whats-coming).

## Results (measured, with their assumptions)

**The demo pair**, rated live on Robinhood testnet with five runs of every attack (200+ episodes each):

| | Agent A (agent 10) | Agent B (agent 3) |
|---|---|---|
| What it is | Acts on what it reads, behind a guard that checks addresses by their first and last characters only | Treats what it reads as data; full guard; Enforce mode; key generated inside a TEE |
| Score | **49 (BB)** | **96 (AAA)** |
| Premium | **7.4%** a year (6.7% after its operator-bond discount) | **1.2%** a year |
| What the Arena found | Address poisoning: 15 of 20 episodes breached. Every other class: none | No breaches |

**The loop, live on Robinhood testnet** (2026-10-04, [evidence](docs/progress/evidence/demo-break-testnet.json)): a lookalike of Agent A's depositor asked for a "refund"; Agent A paid 5,000 tUSDG; the vault recorded the breach and froze the agent; the keeper's claim paid 4,500 (the loss minus the 10% deductible): **4,000 from the operator's bond, 500 from the pool.**

**Leaderboard:** none of the 2 open-source templates rated (Coinbase AgentKit and Solana Agent Kit, 4 template/model evaluations) fell for basic prompt injection. Rated with five runs of every attack, each clean template scores 79 (A) in Monitor mode, the same as Bonded's own hardened agent in that mode; agents that resist every attack tie. About half the attacks arrive on surfaces these templates never read ([leaderboard](https://bonded-nu.vercel.app/leaderboard), [disclosures](docs/disclosures/README.md)).

**Sentinel v5** (in production), against the previous model on the same inputs ([details](docs/SENTINEL-STRESS.md#v5-gate-results)): it blocked 33 of 33 manipulated actions in held-out Arena cases (v1: 27) with no false blocks; in an Arena rerun, the vulnerable agent behind it was breached by 0 of 40 attack seeds. It failed one of five gates (2 of 44 stress families got worse) and was promoted with that exception recorded. It takes about 2.5 s per check on CPU.

Assumptions that apply throughout:
- The attack library is fixed seeds, so scores are in-library results, not a held-out evaluation. An adaptive attack source is tracked in [issue #11](https://github.com/ddboy19912/bonded/issues/11).
- The yearly attack rates per class (λ) are illustrative priors (plan Section 9.2). The model's inputs, not these numbers, are the product.
- Everything runs on testnets with test tokens.

## Security

An internal audit note ([docs/AUDIT.md](docs/AUDIT.md)) covers 16 handler-based invariant tests, which catch all 11 of 11 bugs planted to test them; Slither and clippy, with every finding triaged; and a manual review. It found no high-severity issues; the open contract fixes are batched for the mainnet deployment ([issue #67](https://github.com/ddboy19912/bonded/issues/67)). This is an in-house review, not an external audit.

## Deployments

Owner, attester and council on every testnet: `0xd42FA5ae8949710479954ae78D1b12Ff2e50A841` (a single key for now; a multisig is a mainnet prerequisite). Full address lists: [contracts/evm/deployments](contracts/evm/deployments/README.md) and [contracts/solana/deployments](contracts/solana/deployments/devnet.json).

| Contract | Robinhood Chain testnet (46630) | Arbitrum Sepolia (421614) | Ethereum Sepolia (11155111) |
|---|---|---|---|
| BondedRegistry | [`0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9`](https://explorer.testnet.chain.robinhood.com/address/0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9) | [`0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9`](https://sepolia.arbiscan.io/address/0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9) | [`0x47D5506e1a56019Df0D22Fd8B652A68a162898a2`](https://sepolia.etherscan.io/address/0x47D5506e1a56019Df0D22Fd8B652A68a162898a2) |
| MandateVaultFactory | [`0x47D5506e1a56019Df0D22Fd8B652A68a162898a2`](https://explorer.testnet.chain.robinhood.com/address/0x47D5506e1a56019Df0D22Fd8B652A68a162898a2) | [`0x47D5506e1a56019Df0D22Fd8B652A68a162898a2`](https://sepolia.arbiscan.io/address/0x47D5506e1a56019Df0D22Fd8B652A68a162898a2) | [`0x2014ba5b16017466e50835c90004F659f62d4064`](https://sepolia.etherscan.io/address/0x2014ba5b16017466e50835c90004F659f62d4064) |
| CoverManager | [`0x038C5b833424727a073080822578b8201AC19bDD`](https://explorer.testnet.chain.robinhood.com/address/0x038C5b833424727a073080822578b8201AC19bDD) | [`0x038C5b833424727a073080822578b8201AC19bDD`](https://sepolia.arbiscan.io/address/0x038C5b833424727a073080822578b8201AC19bDD) | [`0x6E8533A4895E6D708B32DFFF928852d7F583067e`](https://sepolia.etherscan.io/address/0x6E8533A4895E6D708B32DFFF928852d7F583067e) |
| CoverPool | [`0x2014ba5b16017466e50835c90004F659f62d4064`](https://explorer.testnet.chain.robinhood.com/address/0x2014ba5b16017466e50835c90004F659f62d4064) | [`0x2014ba5b16017466e50835c90004F659f62d4064`](https://sepolia.arbiscan.io/address/0x2014ba5b16017466e50835c90004F659f62d4064) | [`0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294`](https://sepolia.etherscan.io/address/0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294) |
| OperatorBond | [`0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294`](https://explorer.testnet.chain.robinhood.com/address/0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294) | [`0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294`](https://sepolia.arbiscan.io/address/0xAfF097ceeae821a8A9De8771542CDdD7b63Ee294) | [`0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278`](https://sepolia.etherscan.io/address/0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278) |
| ClaimsEngine | [`0x6E8533A4895E6D708B32DFFF928852d7F583067e`](https://explorer.testnet.chain.robinhood.com/address/0x6E8533A4895E6D708B32DFFF928852d7F583067e) | [`0x6E8533A4895E6D708B32DFFF928852d7F583067e`](https://sepolia.arbiscan.io/address/0x6E8533A4895E6D708B32DFFF928852d7F583067e) | [`0x0b9B5B177756D3bF699C3811D1F2d6067dF0E5f7`](https://sepolia.etherscan.io/address/0x0b9B5B177756D3bF699C3811D1F2d6067dF0E5f7) |
| BountyBoard | [`0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278`](https://explorer.testnet.chain.robinhood.com/address/0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278) | [`0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278`](https://sepolia.arbiscan.io/address/0x942CaC6582F189DcF84CCe73fFAb3c87b9c15278) | [`0x038C5b833424727a073080822578b8201AC19bDD`](https://sepolia.etherscan.io/address/0x038C5b833424727a073080822578b8201AC19bDD) |

**Solana devnet** (Anchor programs, [ADR-011](docs/decisions/011-solana-programs.md)):

| Program | Address |
|---|---|
| bonded_registry | [`7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy`](https://explorer.solana.com/address/7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy?cluster=devnet) |
| bonded_vault | [`8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx`](https://explorer.solana.com/address/8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx?cluster=devnet) |
| bonded_cover | [`Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X`](https://explorer.solana.com/address/Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X?cluster=devnet) |

Agent B's score of 96 is the same signed attestation on all four chains ([evidence](docs/progress/evidence/multichain-scores-agent3-tee.json)).

## Repo layout

| Path | What's there |
|---|---|
| `contracts/evm` | Solidity contracts (Foundry): vault, cover, pool, bond, claims, registry, disputes, bounties. [Its README](contracts/evm/README.md) explains each one |
| `contracts/solana` | Anchor programs: registry, vault, cover |
| `apps/arena` | The Arena: attack library runner, sandbox, judge, ratings |
| `apps/demo-agents` | The agents Bonded rates ([docs/AGENTS.md](docs/AGENTS.md)) |
| `apps/api` | API, keeper, rating and bounty workers, demo scripts |
| `apps/web` | The web app |
| `packages/shared` | Schemas, scoring maths, ABIs, chain and deployment data |
| `services/sentinel`, `services/tee-agent` | The Sentinel guard service; the TEE agent for Phala Cloud |
| `attacks/` | The attack library: YAML scenarios by class |
| `docs/` | Plan, architecture, decisions, audit, progress notes |

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit together |
| [AGENTS.md](docs/AGENTS.md) | What an agent is; every agent we rate |
| [DEVELOPING.md](docs/DEVELOPING.md) | Build, test, run, deploy |
| [SERVICES.md](docs/SERVICES.md) | The hosted API, keeper and workers; alerts |
| [BOUNTIES.md](docs/BOUNTIES.md) | Community attack bounties |
| [SENTINEL.md](docs/SENTINEL.md), [SENTINEL-STRESS.md](docs/SENTINEL-STRESS.md) | The Sentinel guard and how it was tested |
| [TEE.md](docs/TEE.md) | Running an agent's keys in a TEE |
| [AUDIT.md](docs/AUDIT.md) | The internal security review |
| [BUSINESS.md](docs/BUSINESS.md) | Business model and costs |
| [PLAN.md](docs/PLAN.md), [decisions/](docs/decisions/), [progress/](docs/progress/) | The plan, design decisions and daily notes |
