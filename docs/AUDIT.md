# Internal audit note (Day 13)

This is the internal audit note Section 17 asks for before submission. It covers the EVM contracts, the Solana programs, and the off-chain services and web app. It is an in-house review by the team and Claude, **not an external audit**. Read it as "what we checked, what we found, and what is still open".

- **Date:** 2026-10-03 (build Day 13)
- **Code reviewed:** `main` at `016f29a`, plus the Day 13 branches named below
- **Deployed contracts:** the testnet deployments in `contracts/evm/deployments/` were not changed. No finding forced a redeploy (see "Redeploy decision")

## Summary

| Severity | Found | Fixed | Fixed off chain, contract fix at next deploy | Accepted for testnet, fix before mainnet |
|---|---|---|---|---|
| High | 0 | | | |
| Medium | 2 | | 1 (F-01) | 1 (F-02) |
| Low | 4 | 2 (F-04, F-05) | | 2 (F-03, F-06) |
| Informational | 3 | | | 3 (F-07 to F-09) |

No high-severity finding. Every contract fix that remains is listed in the mainnet prerequisites, [issue #67](https://github.com/ddboy19912/bonded/issues/67).

## Method

| Check | Tool or approach | Result |
|---|---|---|
| Invariant tests | Foundry, handler-based, CI profile (256 runs, depth 64), branch `invariant-tests` | 16 invariants and 1 inflation fuzz test pass. Stress run: 1,000 runs per invariant and 50,000 fuzz runs |
| Do the invariants catch bugs? | `contracts/evm/test/invariant/mutations.py` plants one known bug per property | 11 of 11 planted bugs caught |
| Static analysis, EVM | Slither 0.11.6, `slither . --filter-paths "lib/\|test/\|script/"` | 0 high, 12 medium, 54 low, 19 informational, 5 optimisation. Triage below |
| Static analysis, Solana | `cargo clippy --all-targets` (Rust 1.89), then with `-W clippy::pedantic` | Default lints: 0 warnings. Pedantic: the 2 casts in on-chain code checked and safe |
| Manual review | Section 25 checklist; the off-chain list in the Day 13 plan | Findings below |

What the invariants cover:

| Contract | Properties |
|---|---|
| CoverPool | Every share is held by an underwriter; assets equal the token balance; locked capital is `ceil(active cover / leverage)` and free capital is the rest; no withdrawal ever took more than the free capital at that moment |
| CoverManager | Total, per-agent and per-model-family exposure equal the sum over active policies |
| ClaimsEngine | The pool pays only once the bond is empty; payout never exceeds loss minus deductible; bond + pool + netted premium add up to the payout; each breach is paid once, and the vault's record agrees |
| OperatorBond | Bond = staked − withdrawn − slashed for every agent; slashed ≤ staked; the contract holds exactly the sum of bonds |
| MandateVault (ERC-4626) | Every share is held by a depositor; shares never promise more than NAV; deposit, mint, withdraw and redeem all round in the vault's favour; a deposit-then-redeem never makes a profit; no one is promised more base asset than the vault holds; the first-depositor inflation attack never pays, and costs the attacker at least what it costs the victim |
| BountyBoard | Paid ≤ funded and the balance is the difference; only the hunter receives the reward; status moves only Committed → Revealed → Accepted/Rejected (or Committed → Rejected) and final states never change; only attesters decide; a reward is recorded only on an accepted submission |

The handler drives real user actions: underwriter deposits and cooldown exits, operator stakes and withdrawals, cover purchases signed by the attester key, agent breaches in Monitor mode, guardian unfreezes, keeper claims (including the same breach twice in one claim), premium accrual, governance changing the leverage limit, time passing, price moves and donations.

## Findings

### F-01 (Medium) An attester can accept its own bounty submission

`BountyBoard.accept` checks that the caller is an attester, but not that the caller isn't the hunter. An attester key could commit an attack, reveal it and pay itself from the bounty pool.

- **Impact:** limited to the bounty pool (about $9,500 of test tUSDG today). It needs the attester key, which can already sign quotes, so it is not a new trust assumption, but it removes one check on that key.
- **Status: fixed off chain** (branch `bounty-self-accept`). The bounty worker reads `BondedRegistry.isAttester(hunter)` on every fresh attempt and rejects such a submission on chain without running the attack. A test has the attester commit and reveal an attack that would earn 500 tUSDG from a normal hunter: it is rejected, with no `Accepted` event. Without the check, the same test sees the submission paid.
- **Contract fix at the next BountyBoard deployment (#67):** `accept` reverts when the hunter is an attester (or `hunter == msg.sender`).

### F-02 (Medium for mainnet, accepted on testnet) All contracts are owned by one EOA

Every contract on Robinhood testnet, Arbitrum Sepolia and Ethereum Sepolia is owned by the deployer, an externally owned account (`0xd42F…A841` on Robinhood testnet). The owner can add attesters, change risk parameters and, on testnets, set MockOracle prices. Section 17 says "attester set behind a multisig owner"; that isn't true yet.

- **Status:** accepted for the testnet demo. Moving ownership to a multisig (`Ownable2Step`, so no redeploy) and moving the attester key to a KMS or threshold signer are both listed in #67.

### F-03 (Low) A claim paid during an agent's call can hide part of a loss

`MandateVault.execute` measures a call's loss as outflow minus inflow across the vault's assets. If the called contract triggers a payout into the same vault while the call is running (for example `ClaimsEngine.fileClaim` for an earlier unclaimed breach, or `DisputeModule.finalize`), that payout counts as inflow and reduces the loss recorded for the new breach.

- **Preconditions:** a compromised or tricked agent calling an attacker's contract that can move vault funds (it needs an approval or a hook on an allowed target), an earlier breach that is still unclaimed, and the guardian unfreezing the vault before the keeper files that claim. The keeper files within seconds and a breach freezes the vault, so all three together are unlikely.
- **Impact:** depositors are under-compensated by at most the payout that arrived during the call.
- **Status:** accepted for testnet. **Fix at the next deployment (#67):** the vault exposes whether it is inside `execute`, and ClaimsEngine refuses to pay into a vault that is (or `markBreachClaimed` and the dispute path become `nonReentrant` on the vault).

### F-04 (Low) The public bounty reveal endpoint had no rate limit

`POST /bounties/:id/reveal` needs no operator token and reads the chain on every request, so anyone could spend the API's RPC quota.

- **Status: fixed** (branch `static-analysis`). A limit of 10 requests per client and 120 in total per 10 minutes, checked before any chain read; over the limit the API answers 429. The client address is taken from the proxy's `X-Real-IP` (or the last `X-Forwarded-For` entry), not from the parts a client can forge. The shared limit stops anyone getting around it by rotating addresses. Tested.

### F-05 (Low) The leaderboard read the chain on every visit

`GET /leaderboard` checks each entry against the registry: one RPC call per entry, per visit.

- **Status: fixed** (branch `static-analysis`). The response is reused for 60 seconds. Tested.

### F-06 (Low) ChainlinkOracle accepts a sequencer feed with `startedAt == 0`

Chainlink's L2 sequencer feed can return `startedAt == 0` for a round that isn't initialised; the recommended check rejects it. `_checkSequencer` doesn't.

- **Status:** accepted. Every testnet uses MockOracle, so this code isn't live. **Fix before mainnet (#67).**

### F-07 (Informational) A tiny deposit after a large donation can round to 0 shares

Found by the inflation fuzz test. If someone donates 10,000,000 tUSDG to an empty vault, a following 1 tUSDG deposit gets 0 shares. The attacker loses about half the donation, so the attack never pays (the fuzz test checks this at 50,000 runs), but the small depositor loses the deposit.

- **Status:** accepted. Optional fix at the next deployment: revert deposits that would mint 0 shares.

### F-08 (Informational) MockOracle prices are set by the owner

On testnets the owner sets every price, and losses are priced with them. This is by design for the demo (Section 17: "MockOracle only on testnets").

### F-09 (Informational) The keeper stops on a deep chain reorganisation

It waits for an operator instead of recovering. Tracked in [issue #25](https://github.com/ddboy19912/bonded/issues/25), needed before mainnet.

## Slither triage

| Detector | Count | Verdict |
|---|---|---|
| `reentrancy-no-eth` (CoverManager `buyCover`, `cancel`, `_accrue`) | 3 | False positive. Every external entry point of CoverManager is `nonReentrant`; the only external call is `payPremium` on a factory vault, which transfers USDG (a standard token) and is itself `nonReentrant` |
| `reentrancy-no-eth` (MandateVault `execute`) | 1 | Guarded: `execute`, deposits, withdrawals, `reconcile` and `payPremium` are `nonReentrant`, and the rest are guardian- or module-only. The one real effect is F-03 |
| `uninitialized-local` | 4 | False positive: the variables are meant to start at zero (`hasBase`, `otherUsd6`, `lossUsd6`, the `Payout` struct) |
| `unused-return` (ChainlinkOracle) | 2 | Intended: `roundId` and `answeredInRound` aren't needed; price, `updatedAt` and the sequencer status are checked. See F-06 |
| `unused-return` (DisputeModule, ClaimsEngine) | 2 | Intended: `getPolicy` is called as an existence check; `payDispute` only needs the end of the coverage window |
| `calls-loop` | 29 | Accepted: loops are over a vault's assets (at most 16) and a claim's breach ids; the callees are the vault's own tokens and oracle |
| `timestamp` | 22 | Intended: cooldowns, premiums and coverage windows are time-based. Block-time skew of seconds doesn't matter at these scales (hours to days) |
| `reentrancy-benign` | 2 | Same calls as above, guarded |
| `missing-zero-check` (`measuredCall` target) | 1 | False positive: a call to a codeless address fails explicitly |
| `dead-code` | 3 | False positive: OpenZeppelin `_deposit` and `_withdraw` overrides, called through `super` |
| `missing-inheritance` (ClaimsEngine and `IDisputePayer`) | 1 | Cosmetic. Adding it at the next deployment |
| `unindexed-event-address` | 12 | Accepted: set-once admin events, read rarely |
| `assembly`, `low-level-calls` | 3 | Intended: re-throwing the target's revert data and calling the agent's target |
| `cache-array-length` | 5 | Gas only; left as is |

## Solana programs

`cargo clippy --all-targets` reports no warnings on `bonded_vault`, `bonded_cover`, `bonded_registry` and the client crates. The pedantic lints flag two casts in on-chain code, both safe: a breach id cast to `u8` (at most 16 breaches per vault) and the policy term cast to `u128` (a positive constant set at initialisation). The other casts are in tests and the off-chain client. The programs have no invariant tests; their behaviour is covered by the existing unit tests and the devnet end-to-end run from Day 10.

## Section 25 checklist (contracts)

| Item | Result |
|---|---|
| Only factory vaults are claimable | Yes: `buyCover` requires `factory.isVault`, and claims are paid only for a policy's vault |
| Each breach is claimable once | Yes, both in ClaimsEngine and on the vault; invariant `EachBreachPaidOnce` |
| The waterfall pays the bond before the pool | Yes; invariant `BondPaysBeforePool` |
| ERC-4626 math (NAV, inflation, rounding) | Yes; four vault invariants and the inflation fuzz test. F-07 noted |
| Pool locked/free capital | Yes; invariants `FreeCapitalIsAssetsMinusLocked` and `WithdrawalsNeverTouchLockedCapital` |
| Capacity, per-agent and model-family caps in `buyCover` | Yes, `_checkRisk`; invariant `ActiveCoverMatchesPolicies` keeps the totals they rely on exact |
| Access control | Yes: the agent key (`execute`), guardian (freeze, unfreeze, rotate), CoverManager-only (`payPremium`) and ClaimsEngine-only (`markBreachClaimed`, `payClaim`, `slash`, `recordClaim`); modules are set once. Owner powers: F-02 |
| Freeze-on-breach stops a compromised agent draining the payout | Yes: cover requires `freezeOnBreach`, payouts go into the frozen vault, and only the guardian can unfreeze |
| Reentrancy and CEI | Every state-changing entry point that makes an external call is `nonReentrant`. F-03 is the one cross-contract effect |
| Oracle staleness | Yes: Chainlink heartbeat and sequencer checks. F-06 |

## Off-chain review

| Area | Result |
|---|---|
| Public `POST /bounties/:id/reveal` | 16 KB body limit for every route; the spec must hash to the specURI revealed on chain; now rate-limited (F-04) |
| CORS | Allowlist from `WEB_ORIGINS`; unknown origins get no CORS headers |
| API token | At least 24 characters, compared in constant time; required on every POST except the bounty reveal |
| Attester key | One key for quotes (API), ratings and bounty payouts (worker); the worker serialises sends with a per-chain lock. KMS or threshold signer before mainnet (F-02, #67) |
| Server-sent events | At most 5 listeners per API instance |
| Logs | Errors log only the error name, never the message (messages can carry the RPC URL and its key) |
| Keeper and worker failures | Every loop retries with a delay; payouts store the decision and nonce before broadcasting, so a crash can't pay twice. Silent retries are what the Day 13 alerts address ([issue #24](https://github.com/ddboy19912/bonded/issues/24)) |
| Web transactions | Exact token approvals (never unlimited); every transaction is pinned to the Robinhood testnet chain id; the operator token is kept in memory only; bounty salts come from a secure random source |

## Redeploy decision

The plan says a contract-level BountyBoard check ships only if this review forced a redeploy anyway. It didn't: there is no high-severity finding, and every open contract finding (F-01's contract check, F-03, F-06, F-07, and the IDisputePayer cosmetic) needs a deployment that would change every testnet address, the recorded evidence and the scores on four chains, two days before submission. They are batched for the next deployment, which is the mainnet one (#67).
