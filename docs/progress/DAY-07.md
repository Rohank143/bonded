# Day 7: API, keeper and Gate 1

Build-day label: **Day 7**. Executed on September 28, 2026; this is the build sequence, not the calendar date in the original schedule.

## Delivered

- `packages/db`: Drizzle schema, SQL migration, agents, ratings, attestations, quotes, job leases, per-chain keeper cursors, discovered vaults/policies, handled breaches and durable live events.
- `apps/api`: Hono health, score, quote, rating/run/report and SSE endpoints. POST requests require a server token. Quotes read registry attestations, bond, aggregate agent exposure and all three risk caps, then simulate `buyCover`.
- `apps/keeper`: factory discovery, historical policy tracking, breach ingestion, claim eligibility checks, automatic `fileClaim`, premium accrual and restart recovery. Failed claims remain pending independently of the block cursor.
- Arena worker: server-configured scripted adapters, 42 sandbox episodes, awaited progress events, persisted reports and signed attestations, on-chain posting and crash recovery.
- Dockerfile, Compose and Railway infrastructure as code (`.railway/railway.ts`). The API, keeper and Arena worker run live on Railway with Postgres; see "Hosted services" below.
- `pnpm gate:local` and `pnpm gate:testnet`: complete runnable demos. The latter sends actual testnet transactions.
- Event retention (hourly, 30 days by default) and the hosted agents file `config/agents.46630.json`.

PRs are stacked: `api-keeper` is based on `main`; `gate-1-e2e` is based on `api-keeper`. The founder reviews and merges them in that order.

## Verification

The API/keeper commit passed the complete pipeline in a fresh clone with submodules: frozen install, Prettier, ABI drift, TypeScript, ESLint, all default TypeScript tests, Forge formatting and Forge tests. Counts at that commit: **230 TypeScript tests passed**, **156 Solidity tests passed**; two opt-in external-fork tests skipped. After review fixes and the Day 7 close-out, `main` has **248 TypeScript tests** (23 in the API package) and the same 156 Solidity tests. The service tests use real embedded Postgres 18 and Anvil, including claim retry, lease fencing, chain isolation, SSE replay, worker episodes and interrupted-post recovery.

The local Gate 1 rehearsal passed, including keeper restart. It rated the scripted hardened adapter in Monitor mode: **56 (BB)**, 42 episodes (40 fixed attack seeds and two controls), zero agent errors and zero control breaches. This is an in-library demonstration, not a held-out evaluation. Priors and upper credible bounds remain the Day 6 actuarial assumptions. A deliberately injected 1,000-unit transfer produced a 900-unit payout after the 10% deductible.

The injected transfer is an explicit test fixture sent with the demo agent key after rating. It is not evidence that the rated hardened adapter was jailbroken.

## Testnet evidence

The first attempt stopped during setup after the load-balanced RPC briefly failed to return a receipt already confirmed by the sender. Its partial transaction list is retained in `evidence/gate-1-attempt-1.json`. The script now waits for the receipt again, with two confirmations on testnet. That attempt bought no cover and injected no breach.

Completed **2026-09-28T13:57:20.880Z** on chain **46630**. Agent **2**, vault `0x0B2B5b9e914C949C14b41ADC002338877f0AA623`.

All 42 episode events were persisted. The posted rating is **56 (BB)** with zero agent errors. The quote bound **20,000 tUSDG** of cover. After a deliberate 1,000 tUSDG transfer, the keeper paid automatically; the measured vault balance increase was **899.999311 tUSDG**, after premium accrual. A new keeper instance resumed and produced no duplicate claim.

| Step | Transaction |
|---|---|
| register | [`0x2df1fb70074dfbc8f393c6e12449d63c34c7402acdb2fb98e548c69ad6200637`](https://explorer.testnet.chain.robinhood.com/tx/0x2df1fb70074dfbc8f393c6e12449d63c34c7402acdb2fb98e548c69ad6200637) |
| createVault | [`0x5db06c44f38aefab9a498c3c5bd95b204d065a6d20c12650923782ff86a2ffdb`](https://explorer.testnet.chain.robinhood.com/tx/0x5db06c44f38aefab9a498c3c5bd95b204d065a6d20c12650923782ff86a2ffdb) |
| faucet | [`0xed11cd226740ebedf89fbeedf7330d11d6d011fdcc4f79904594f03ba9fffb60`](https://explorer.testnet.chain.robinhood.com/tx/0xed11cd226740ebedf89fbeedf7330d11d6d011fdcc4f79904594f03ba9fffb60) |
| approve | [`0xae71af89bff28f5f2b599e3a7c090d5ffa874b2961e5726478f92dada89e8e37`](https://explorer.testnet.chain.robinhood.com/tx/0xae71af89bff28f5f2b599e3a7c090d5ffa874b2961e5726478f92dada89e8e37) |
| deposit | [`0xb8cf2fefbb5b3525dad7e78e9b25c223619d8d889b869053721b500ae4f9dca6`](https://explorer.testnet.chain.robinhood.com/tx/0xb8cf2fefbb5b3525dad7e78e9b25c223619d8d889b869053721b500ae4f9dca6) |
| approve | [`0x9448be909211ad217be0bf5d62de01c62af8881188d0a9126b08143bdc9a3e20`](https://explorer.testnet.chain.robinhood.com/tx/0x9448be909211ad217be0bf5d62de01c62af8881188d0a9126b08143bdc9a3e20) |
| stake | [`0xe7a8ff7196d8efdb9a0d8b8d79d8b3424383ca51dc0d2e00b74260f940a8f413`](https://explorer.testnet.chain.robinhood.com/tx/0xe7a8ff7196d8efdb9a0d8b8d79d8b3424383ca51dc0d2e00b74260f940a8f413) |
| approve | [`0x0654df42174e5130b63e27eb9b701d19ae2d9683245e3ce2870fc6cdd5093b81`](https://explorer.testnet.chain.robinhood.com/tx/0x0654df42174e5130b63e27eb9b701d19ae2d9683245e3ce2870fc6cdd5093b81) |
| deposit | [`0x47139ca8e3cb6dc0ca9a9af8ec59487fbcc0a176a393a8613ddcd8db700e8277`](https://explorer.testnet.chain.robinhood.com/tx/0x47139ca8e3cb6dc0ca9a9af8ec59487fbcc0a176a393a8613ddcd8db700e8277) |
| postScore | [`0x0adbd37f6155c56d032f17f6bbc1852bfe8526925150076a6a22ab5f33b631e9`](https://explorer.testnet.chain.robinhood.com/tx/0x0adbd37f6155c56d032f17f6bbc1852bfe8526925150076a6a22ab5f33b631e9) |
| buyCover | [`0xf1de9134417efa2b58c08d0980923cb4b8d68729da2745f63dd871b7feab1c62`](https://explorer.testnet.chain.robinhood.com/tx/0xf1de9134417efa2b58c08d0980923cb4b8d68729da2745f63dd871b7feab1c62) |
| execute | [`0xb0af8d2f9f76137f4087268f9b38a663c020d9cdad06f95d104b0215532af466`](https://explorer.testnet.chain.robinhood.com/tx/0xb0af8d2f9f76137f4087268f9b38a663c020d9cdad06f95d104b0215532af466) |
| fileClaim (keeper) | [`0xb2f23bb458e90b921a582b6d0b9d263ad095bbbcbc365f786ce034043d186d7d`](https://explorer.testnet.chain.robinhood.com/tx/0xb2f23bb458e90b921a582b6d0b9d263ad095bbbcbc365f786ce034043d186d7d) |

Independent receipt verification confirmed all **13 transactions succeeded**. `ClaimPaid` reports policy **1**, breach **0**, loss **1,000 tUSDG**, gross payout **900 tUSDG**, **900 from the bond**, **0 from the pool**, and **0 premium netted**. The smaller balance increase reflects premium accrual in separate transactions.

The evidence also preserves `reportJson`: hashing its UTF-8 bytes with Keccak-256 reproduces the on-chain report hash. For this run, the original serializer order was recovered from the stored report and hash-verified. Migration 2 now stores the exact report bytes directly, and an integration assertion checks the API response against the signed hash.

Full machine-readable evidence: [gate-1-testnet.json](evidence/gate-1-testnet.json). This includes the report, signed attestation, signed quote and before/after balances.

The `claim`, `verifiedReceipts` and `reportHashVerified` fields in that file were added after the testnet run by a separate check against the chain; the script that produced the run did not write them. The script now decodes `ClaimPaid`, re-checks every receipt, verifies the report hash and counts on-chain `ClaimPaid` logs after the keeper restart itself, so a new run produces all of these fields directly. The local demo was re-run with these checks and passed.

## Hosted services

Gate 1's hosting half is complete: the core loop runs live on Railway against Robinhood Chain testnet.

- **Public API:** https://api-production-ba50.up.railway.app. `GET /health` returned `{"ok":true,"chainId":46630}` with status 200 from outside Railway.
- **Services:** `api`, `keeper` and `arena-worker` from one Docker image, plus Postgres 18, region `sfo`. Defined in `.railway/railway.ts`; signing keys and the API token are Railway secrets. The keeper uses its own funded account, separate from the attester.
- **Deploys from `main`:** the image builds on Railway without git submodules (the Dockerfile fetches the pinned contract libraries). The deploy from merge commit `5110f38` succeeded.
- **Restarts:** each of the three services was restarted on Railway and logged ready again within seconds; `/health` stayed at 200. The keeper resumed from its saved cursor (block 125,413,719 before, still advancing after) instead of rescanning from the deployment block.
- **Keeper on live data:** starting from the deployment block, the hosted keeper caught up with the chain head (block 125,895,237 against a head of 125,895,253 at 22:04 UTC). It discovered both vaults and policy 1, and found the Gate 1 breach already paid: it marked it `claimed` without sending a second claim.
- **Docker runtime:** before deploying, the image ran locally against Anvil with Postgres 16, with all roles in one container and each role in its own container; `/health`, a container restart and keeper progress were checked.
- **Spending:** $10 soft and $25 hard workspace limits. Expected cost is about $3 a month.

The hosted services have not yet rated a new agent or paid a new claim on their own; Gate 1's rating and payout ran through the same code in `pnpm gate:testnet`. Retention and monitoring are described in `docs/SERVICES.md`.

### Follow-ups

- External uptime check (for example UptimeRobot) on `https://api-production-ba50.up.railway.app/health`, emailing the founder when it fails.
- Alerts to a chat channel for crashes and stuck keeper claims.
- Top up testnet ETH: the attester (deployer) had about 0.0067 ETH and the keeper 0.003 ETH at deploy time.
- Automatic deep-reorg recovery for the keeper; today it stops and waits for an operator.

## Section 25 review checklist

Checked items below record automated evidence within this task, not a substitute for founder or independent security review.

### Product and pitch

- [x] The demonstrated payout is for an out-of-mandate transfer; the contract decides it deterministically.
- [x] AI output remains advisory; neither a report nor the API can override claim checks.
- [ ] Held-out performance claims: not established by this demonstration. Fixed-seed results and assumptions are explicitly labelled above.

### Contracts

- [x] Existing factory provenance, single-claim, bond-first waterfall tests pass; service tests prove automatic payout without a duplicate on restart.
- [x] Existing ERC-4626, rounding and capital tests, including Foundry fuzz tests, pass.
- [x] Capacity, per-agent and model-family contract checks pass; the API reads them before signing and simulates binding.
- [x] Existing access-control tests pass; POST endpoints require a token.
- [x] Freeze-on-breach is enforced by the vault and required when binding cover.
- [ ] Independent reentrancy/CEI/oracle-staleness audit: not performed here. Existing tests pass; no contracts changed.

### Arena and actuarial model

- [x] The judge reads on-chain breach logs in Anvil; the fork uses the deployed contracts.
- [x] Existing credible-bound/formula tests pass; reports retain sample counts and assumptions.
- [x] Attack actions run in the local fork. Only the signed final attestation is posted to testnet.
- [x] Score, expected-loss and premium tests pass, including TypeScript quote acceptance by `buyCover`.

### Sentinel

- [ ] Minimal-context/negation evaluation: later build-day work, not part of Gate 1.
- [ ] Held-out TPR@1%FPR, calibration and latency: not measured here.
- [ ] Pinned Sentinel model and fallback verification: not part of this service change.

### Engineering

- [ ] Hosted CI green: GitHub Actions remains paused for the pre-existing billing issue. The EVM/TypeScript pipeline passed locally in a fresh clone; Anchor is later work.
- [x] Environment variables documented; no private keys or `.env` files committed.
- [x] `pnpm gate:local` completed using real Postgres and Anvil without Docker.
- [x] Migrations run before roles start; keeper restart and claim deduplication pass.
- [x] Public hosted API `/health` returns 200 on Railway; each service restarted cleanly and the keeper resumed from its cursor.
- [x] Event retention runs hourly; spending limits set. An external uptime check is a listed follow-up.

## Review

Run `pnpm test:services` and `pnpm gate:local`. Expect the vault balance to increase after the keeper submits the claim and only one `claim.paid` event after restart. Inspect `apps/api/src/quotes.ts`, `apps/keeper/src/index.ts`, and `docs/SERVICES.md` for underwriting, retry behavior and deployment limits.

The hosting gate is complete (see "Hosted services"). Automatic deep-reorg rollback, guardian alerts, an external uptime check, arbitrary agent adapters and Sentinel evaluation remain outside this delivered slice.
