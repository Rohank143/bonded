# ADR-011: Solana programs

- **Status:** Accepted
- **Date:** 2026-09-29
- **Code:** `contracts/solana/` (Anchor 1.x workspace: `programs/bonded_registry`, `programs/bonded_vault`, `programs/bonded_cover`, `crates/bonded_ed25519`)

## Context

Day 9 of the plan: the Solana programs (vault, cover, registry) in Anchor, done when they compile. Section 7 describes them as a mirror of the EVM contracts, with Solana-specific constraints. Day 10 adds devnet deployment, keeper and SDK support, and the remaining tests.

## Decisions

### 1. Signed messages are checked through the Ed25519 program

Programs can't verify Ed25519 signatures cheaply themselves. The transaction instead carries an instruction to Solana's native Ed25519 program right before ours, and that program fails the whole transaction on a bad signature. Our program reads that instruction from the instructions sysvar (`bonded_ed25519::require_signed`) and checks:
- it verifies exactly one signature,
- the key, signature and message are all inside that instruction (so another instruction can't supply them),
- the key is the attester,
- the message is exactly the expected bytes.

Signed bytes are a domain prefix (`bonded-attestation-v1`, `bonded-quote-v1`), the program id, then the Borsh-encoded struct. A signature for another purpose or another deployment can't be replayed.

### 2. The breach log lives inside the vault account

EVM vaults append breach records to storage. On Solana a new account per breach would need a payer and a known address up front, and the agent's `execute` can't know whether it will breach. So each `Vault` holds up to 16 breaches. The vault freezes on the first breach, and `execute` refuses once the log is full, so 16 is far more than needed. The cover program reads the log directly and marks breaches paid through `bonded_vault::mark_claimed`, which only its `claims` signer can call.

### 3. What `execute` checks

The agent's key can only act through `execute`, and the vault signs the inner call.

| Check | Rule |
|---|---|
| T1 target | The called program must be on the vault's allowlist (at most 8 programs, never the vault program itself). |
| T1 transfer | An SPL Token or Token-2022 `Transfer`/`TransferChecked` must go to a token account whose owner is the vault. `CloseAccount` counts as a transfer out. |
| T1 approval | `Approve`, `ApproveChecked` and `SetAuthority` are never allowed. |
| T2 limit | The vault's base-asset balance may not drop by more than the per-call limit. |

**Enforce** mode records the attempt as blocked and doesn't run the call. **Monitor** mode runs it and records the loss (the base-asset balance drop). Both freeze the vault when `freeze_on_breach` is set, which `buy_cover` requires.

**Not on Solana yet:** T3 (asset) breaches and a daily limit. T3 needs an on-chain price, which Day 10 adds with an oracle adapter.

### 4. Cover mirrors the EVM rules that decide payouts

- **Bonds:** only the agent's registry owner can stake, checked by reading the registry's `Agent` account.
- **Binding cover:** a quote signed by the attester, sent by the vault's guardian, who must also own the agent. The vault must freeze on a breach, the mandate hash must match, the bond must meet the quote's minimum, and total cover must stay within 2× the pool. Each (vault, nonce) quote can be used once.
- **Claims:** anyone can file.
  - The breaches must be unpaid, not blocked, and inside the policy term.
  - The claim must be filed within 7 days after the term.
  - The payout is the loss less a 10% deductible, capped at the remaining cover.
  - It is paid from the bond first, then from the pool, into the vault.
- **Pool withdrawals** may only take capital that isn't backing active cover.

### 5. Deliberate Day 9 simplifications

These don't change who gets paid or how much for a covered breach. Each is listed so it isn't mistaken for parity with EVM:

| EVM | Solana today | When |
|---|---|---|
| Premiums stream from the vault; unpaid premium lapses the policy | The whole term's premium is paid upfront by the guardian | Day 10 |
| Withdrawals wait a cooldown | Immediate, but only from free capital | Day 10 |
| Per-agent and model-family caps | Only the pool-wide 2× cap | Day 10 |
| One active policy per vault | Not enforced | Day 10 |
| Bond withdrawal with cooldown | Bonds can't be withdrawn yet | Day 10 |
| DisputeModule, BountyBoard | Not on Solana | After Gate 2 if needed |

### 6. Program ids

The ids in `declare_id!` and `Anchor.toml` come from keypairs generated locally in `contracts/solana/target/deploy/`. Those stay out of git like every other key. A fresh clone has no keypairs, so `anchor build` would generate new ones and refuse to build on the mismatch. The build and test scripts pass `--ignore-keys`, which is safe because tests load the programs under the committed ids. Deploying must not use it: deploy with the matching keypairs, or run `anchor keys sync` on new ones first (Day 10). Day 10 deployed to devnet with the matching keypairs, and added the TypeScript client (`@bonded/solana`) and the Solana keeper; the steps are in `contracts/solana/README.md` and the addresses in `contracts/solana/deployments/devnet.json`.

## Consequences

- `pnpm solana:build` builds all three programs and their IDLs; `pnpm solana:test` runs the tests (LiteSVM with the Ed25519 precompile, against the built programs).
- The tests cover:
  - the registry refusing a wrong signer, a changed attestation, a missing signature check and a stale version;
  - the full cover flow, including a non-owner stake, an unsigned quote, quote replay, a breach, the frozen agent, the bond-then-pool payout and a double claim;
  - Enforce mode;
  - an off-allowlist program;
  - the per-call limit.
- The Solana programs haven't been audited, and neither have the EVM contracts. Plan Section 25 and Day 13 hardening apply.
