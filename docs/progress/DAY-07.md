# Day 7: API, keeper and Gate 1

Build-day label: **Day 7**. Executed on September 28, 2026; this is the build sequence, not the calendar date in the original schedule.

## Delivered

- `packages/db`: Drizzle schema, SQL migration, agents, ratings, attestations, quotes, job leases, per-chain keeper cursors, discovered vaults/policies, handled breaches and durable live events.
- `apps/api`: Hono health, score, quote, rating/run/report and SSE endpoints. POST requests require a server token. Quotes read registry attestations, bond, aggregate agent exposure and all three risk caps, then simulate `buyCover`.
- `apps/keeper`: factory discovery, historical policy tracking, breach ingestion, claim eligibility checks, automatic `fileClaim`, premium accrual and restart recovery. Failed claims remain pending independently of the block cursor.
- Arena worker: server-configured scripted adapters, 42 sandbox episodes, awaited progress events, persisted reports and signed attestations, on-chain posting and crash recovery.
- Dockerfile, Compose, Railway configuration and environment variables. These files are supplied; no hosted Railway service was deployed during this task.
- `pnpm gate:local` and `pnpm gate:testnet`: complete runnable demos. The latter sends actual testnet transactions.

PRs are stacked: `api-keeper` is based on `main`; `gate-1-e2e` is based on `api-keeper`. The founder reviews and merges them in that order.

## Verification

The API/keeper commit passed the complete pipeline in a fresh clone with submodules: frozen install, Prettier, ABI drift, TypeScript, ESLint, all default TypeScript tests, Forge formatting and Forge tests. Counts: **230 TypeScript tests passed**, **156 Solidity tests passed**; two opt-in external-fork tests skipped. The five service tests use real embedded Postgres 18 and Anvil, including claim retry, lease fencing, chain isolation, SSE replay, worker episodes and interrupted-post recovery.

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

Full machine-readable evidence: [gate-1-testnet.json](evidence/gate-1-testnet.json). This includes the report, signed attestation, signed quote and before/after balances.

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
- [ ] Public hosted API `/health`: not verified. The in-process API health endpoint was exercised; Railway deployment remains outstanding.

## Review

Run `pnpm test:services` and `pnpm gate:local`. Expect the vault balance to increase after the keeper submits the claim and only one `claim.paid` event after restart. Inspect `apps/api/src/quotes.ts`, `apps/keeper/src/index.ts`, and `docs/SERVICES.md` for underwriting, retry behavior and deployment limits.

Before marking the full “core loop live” hosting gate complete, deploy the roles and Postgres to Railway, confirm its public health endpoint and restart behavior, and set monitoring and retention. Docker runtime validation, automatic deep-reorg rollback, guardian alerts, arbitrary agent adapters and Sentinel evaluation remain outside this delivered slice.
