# Internal security review

This note covers the EVM contracts, the Solana programs, and the off-chain services and web app. It is an in-house review, **not an external audit**. Read it as "what we checked, what we found, and what is still open".

- **Date:** 2026-10-03
- **Code reviewed:** `main` at `016f29a`, plus the branches named below
- **Deployed contracts:** the testnet deployments in `contracts/evm/deployments/` were not changed. No finding forced a redeploy (see "Redeploy decision")

## Summary

| Severity | Found | Fixed | Fixed off chain, contract fix at next deploy | Accepted for testnet, fix before mainnet |
|---|---|---|---|---|
| High | 0 | | | |
| Medium | 3 | | 2 (F-01, F-10) | 1 (F-02) |
| Low | 4 | 2 (F-04, F-05) | | 2 (F-03, F-06) |
| Informational | 3 | | | 3 (F-07 to F-09) |

No high-severity finding. Every contract fix that remains is listed in the mainnet prerequisites, [issue #67](https://github.com/ddboy19912/bonded/issues/67).

The MandateModule work (smart-account protection, 2026-10-07) was reviewed afterwards, including an independent adversarial review; its findings (F-11 to F-19) and its effect on F-10 are in [the addendum](#addendum-mandatemodule) at the end.

## Method

| Check | Tool or approach | Result |
|---|---|---|
| Invariant tests | Foundry, handler-based, CI profile (256 runs, depth 64), [PR #70](https://github.com/ddboy19912/bonded/pull/70) | 16 invariants and 1 inflation fuzz test pass. Stress run: 1,000 runs per invariant and 50,000 fuzz runs |
| Do the invariants catch bugs? | `contracts/evm/test/invariant/mutations.py` plants one known bug per property | 11 of 11 planted bugs caught |
| Static analysis, EVM | Slither 0.11.6, `slither . --filter-paths "lib/\|test/\|script/"` | 0 high, 12 medium, 54 low, 19 informational, 5 optimisation. Triage below |
| Static analysis, Solana | `cargo clippy --all-targets` (Rust 1.89), then with `-W clippy::pedantic` | Default lints: 0 warnings. Pedantic: the 2 casts in on-chain code checked and safe |
| Manual review | Section 25 checklist; the off-chain list of checks | Findings below |

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
- **Status: fixed off chain** ([PR #71](https://github.com/ddboy19912/bonded/pull/71)). The bounty worker reads `BondedRegistry.isAttester(hunter)` on every fresh attempt and rejects such a submission on chain without running the attack. A test has the attester commit and reveal an attack that would earn 500 tUSDG from a normal hunter: it is rejected, with no `Accepted` event. Without the check, the same test sees the submission paid.
- **Contract fix at the next BountyBoard deployment (#67):** `accept` reverts when the hunter is an attester (or `hunter == msg.sender`).

### F-02 (Medium for mainnet, accepted on testnet) All contracts are owned by one EOA

Every contract on Robinhood testnet, Arbitrum Sepolia and Ethereum Sepolia is owned by the deployer, an externally owned account (`0xd42F…A841` on Robinhood testnet). The owner can add attesters, change risk parameters and, on testnets, set MockOracle prices. The design calls for the attester set to sit behind a multisig owner; that isn't true yet.

- **Status:** accepted for the testnet demo. Moving ownership to a multisig (`Ownable2Step`, so no redeploy) and moving the attester key to a KMS or threshold signer are both listed in #67.

### F-03 (Low) A claim paid during an agent's call can hide part of a loss

`MandateVault.execute` measures a call's loss as outflow minus inflow across the vault's assets. If the called contract triggers a payout into the same vault while the call is running (for example `ClaimsEngine.fileClaim` for an earlier unclaimed breach, or `DisputeModule.finalize`), that payout counts as inflow and reduces the loss recorded for the new breach.

- **Preconditions:** a compromised or tricked agent calling an attacker's contract that can move vault funds (it needs an approval or a hook on an allowed target), an earlier breach that is still unclaimed, and the guardian unfreezing the vault before the keeper files that claim. The keeper files within seconds and a breach freezes the vault, so all three together are unlikely.
- **Impact:** depositors are under-compensated by at most the payout that arrived during the call.
- **Status:** accepted for testnet. **Fix at the next deployment (#67):** the vault exposes whether it is inside `execute`, and ClaimsEngine refuses to pay into a vault that is (or `markBreachClaimed` and the dispute path become `nonReentrant` on the vault).

### F-04 (Low) The public bounty reveal endpoint had no rate limit

`POST /bounties/:id/reveal` needs no operator token and reads the chain on every request, so anyone could spend the API's RPC quota.

- **Status: fixed** (fixed in this review). A limit of 10 requests per client and 120 in total per 10 minutes, checked before any chain read; over the limit the API answers 429. The client address is the first `X-Forwarded-For` entry, which the hosting platform's edge sets (it strips any value a client sends); `X-Real-IP` is only a fallback, because the platform sometimes fills it with its CDN's address. The shared limit stops anyone getting around it by rotating addresses. Tested.

### F-05 (Low) The leaderboard read the chain on every visit

`GET /leaderboard` checks each entry against the registry: one RPC call per entry, per visit.

- **Status: fixed** (fixed in this review). The response is reused for 60 seconds. Tested.

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

### F-10 (Medium) A vault's mandate hash doesn't prove the rules it enforces

Found in the review of the self-serve work (PR #89). `MandateVaultFactory.createVault` takes the mandate hash and the enforced parameters (mode, assets, targets, destinations, limits) as separate inputs, and nothing checks that the hash is of those parameters. A vault can therefore carry the hash of an Enforce mandate with tight limits while enforcing Monitor with loose ones. `CoverManager` checks only the hash against the quote, so cover could be priced from a rating of rules the vault doesn't enforce.

- **Who could exploit it:** whoever creates the vault, which is the operator who buys the cover: the party the rating is meant to judge.
- **Status: fixed off chain.** Self-serve registration decodes the vault's creation call and refuses a mandate whose parameters differ in any field. The operator's own agents (`config/agents.46630.json`) are created by our scripts with matching parameters.
- **Contract fix at the next deployment (#67):** the factory computes the mandate commitment on chain from the parameters it actually stores (a hash of the ABI-encoded enforced parameters, with the descriptive JSON kept off chain), and ratings, quotes and cover use that commitment.

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
| Keeper and worker failures | Every loop retries with a delay; payouts store the decision and nonce before broadcasting, so a crash can't pay twice. Silent retries are what the alerts address |
| Web transactions | Exact token approvals (never unlimited); every transaction is pinned to the Robinhood testnet chain id; the operator token is kept in memory only; bounty salts come from a secure random source |

## Redeploy decision

The plan says a contract-level BountyBoard check ships only if this review forced a redeploy anyway. It didn't: there is no high-severity finding, and every open contract finding (F-01's contract check, F-03, F-06, F-07, and the IDisputePayer cosmetic) needs a deployment that would change every testnet address, the recorded evidence and the scores on four chains. They are batched for the next deployment, which is the mainnet one (#67).

## Secret scan of the history

The whole git history was scanned for secrets.

| Check | Result |
|---|---|
| gitleaks 8.30.1, every branch and tag plus GitHub's pull-request refs (66), all commits | 12 findings, all false positives: anvil's published test keys (in tests and the local demo script), public test addresses named `KEY` in the TEE tests, a tokenizer file's SHA-256 and an attack id. Fingerprints are in `.gitleaksignore`, so a new scan reports none |
| Token formats gitleaks may not know (common API token formats and private-key blocks), across all history | None |
| Secret files ever committed (`.env`, `.env.local`, keys, `.pem`) | None. Only `.env.example` files, with empty values or local defaults |

Run it again with `gitleaks git --log-opts="--all" .`; it should report "no leaks found".

The code is under the MIT licence (`LICENSE`); `SECURITY.md` says how to report a vulnerability.

## Addendum: MandateModule

- **Date:** 2026-10-07, updated 2026-10-08 after an independent adversarial review of the branch
- **Code reviewed:** branch `mandate-module`: the mandate checks moved into `MandateBase` (shared by `MandateVault` and the new `MandateModule`), `MandateModuleFactory`, and the CoverManager, ClaimsEngine and DisputeModule changes that let a module-protected smart account hold cover
- **Deployed contracts:** not changed. The module needs a new CoverManager, ClaimsEngine and DisputeModule, so it was to ship with the mainnet deployment (#67). Update, 2026-10-10: the testnets were redeployed in full, so the module is live there; the open contract fixes from the first review (F-01's contract check, F-03, F-06, F-07) are still for mainnet

| Severity | Found | Fixed | Accepted, documented |
|---|---|---|---|
| High | 1 | 1 (F-16) | |
| Medium | 3 | 2 (F-17 for modules, F-18) | 1 (F-11, now outside cover) |
| Low | 2 | 1 (F-19) | 1 (F-12, by design) |
| Informational | 3 | | 3 (F-13 to F-15) |

F-16 to F-19 came from the independent review, each with a working proof of concept. Each fix has a regression test, an invariant (F-16, F-18, F-19) and a planted bug in `mutations.py`. The review also found F-12's effect statement wrong; it is corrected below.

F-10 is fixed for modules: `MandateModuleFactory.createModule` refuses a mandate hash that isn't `BondedTypes.mandateCommitment(params)`, the hash of the ABI-encoded enforced parameters. Vaults still carry the JSON hash; the vault factory fix stays in #67.

### Method

| Check | Result |
|---|---|
| Vault behaviour unchanged by the refactor | Every existing test and the 16 existing invariants pass with no change to their code. The vault's generated ABI differs only in the `Breach` struct's internal type name, and its bytecode size is unchanged by the review fixes |
| Vault and module agree | Differential tests feed the same random sequences (16 steps of agent actions, outside pulls, price moves, guardian steps and time) to a vault and a module with the same mandate and funds, in both modes, on the ERC-7579 reference account and on a Safe with Safe7579. After every step: same call outcome and data, breach log field by field, freeze state, 24h window, recorded and actual balances, and BreachRecorded and Executed events. A fixed sequence makes sure every breach type is compared. The one difference by design (F-17: token calls on unlisted tokens) has its own test, and the random steps only use listed tokens |
| Real accounts | The module tests run on the ERC-7579 reference account (`MSAAdvanced` 0.0.2) and on Safe 1.4.1 with Safe7579 1.0.2, installed as executor and hook through each account's own entry points, plus a Safe flow that uses only the owner's `execTransaction` |
| Invariants | A module handler runs beside the existing protocol handler and its two vaults, with three insured Enforce-mode modules (a reference account, a Safe, and an account that only pretends to execute), a Monitor-mode module and an older module of one account: 13 invariants. Payouts reach the account; Deferred breaches on modules are never paid; Monitor-mode modules are never insured; premium collection never stalls; an account never has two modules installed; module disputes are only paid by the council; modules never hold funds; a frozen agent gets nothing through and owner withdrawals through the account are never breaches; plus the waterfall, deductible, paid-once, exposure, bond and pool properties with modules in the mix |
| Planted bugs | `mutations.py` now plants 22 bugs (11 for the module); 22 of 22 caught |
| Slither 0.11.6 | Same command as above, after the review fixes. 0 high, 12 medium, 58 low, 22 informational, 5 optimisation. Every medium is the same finding as before, now reported on `MandateBase` where the code moved. New against the main review: 5 `calls-loop` on the module's account reads (bounded by 16 assets), 1 `timestamp` (`DisputeModule.resolve` waits for the challenge period, intended), 1 `unindexed-event-address` (`ModuleFactorySet`, set-once admin event), 1 `cyclomatic-complexity` (`CoverManager._checkVault`, a list of independent checks), 1 `too-many-digits` (the module's creation code in `predictModule`, a false positive). The `missing-zero-check` on `measuredCall` is gone (the call moved behind `_call`) |

### F-16 (High) The account owner could collect a payout for a breach they asked for

Fixed. In Monitor mode a breach goes through, and on a module the payout goes to `module.account()`, which the owner controls. The owner could tell the agent "send 5,000 to my other wallet": the transfer is a real UnauthorizedTransfer with a real loss, and the claim pays the owner, first from the operator's bond, then from the pool. A vault doesn't have this hole, because its payout restores every depositor's shares (Section 11.3). The same applied to grey-area disputes: anyone can propose one, an unchallenged one used to pay automatically, and on a module the proposer can be the beneficiary.

- **Fix:** CoverManager refuses cover for a Monitor-mode module (`ModuleMustEnforce`). Monitor-mode modules can still be created and still protect an account; they just can't be insured. For a module's policy, DisputeModule never pays an unchallenged proposal by itself (`finalize` reverts with `CouncilDecisionRequired`); the council approves it with `resolve` after the challenge period. Vault policies keep the optimistic flow.
- **Consequence:** in Enforce mode every breach through `execute` is blocked (nothing is lost, so nothing to pay), and Deferred breaches on modules aren't paid (F-12). So a module's cover pays only through council-approved disputes.
- **Tests:** `test_MonitorModulesCantHoldCover`, `test_ModuleDisputePaysTheAccountOnlyWithTheCouncil`, `test_CouncilWaitsForTheChallengePeriod`; invariants `MonitorModulesAreUninsured` and `ModuleDisputesNeedTheCouncil`.

### F-17 (Medium) Tokens outside the asset list could be drained through an allowed target

Fixed for modules. `_classify` checks an approval's spender and a transfer's recipient, not that the token being called is one of the mandate's assets. A smart account usually holds other tokens. In Enforce mode the agent could approve the allowed router for an unlisted token (allowed: the spender is a target), then swap it through the router with the proceeds sent to an attacker. The unlisted token isn't measured, so nothing was recorded and the agent wasn't frozen.

- **Fix (modules only):** on a module, `approve`, `increaseAllowance`, `setApprovalForAll`, `transfer` or `transferFrom` called on a token outside the asset list is a T1 UnauthorizedTarget breach (blocked in Enforce mode). The vault keeps MandateBase's rule unchanged, so its behaviour and published scores don't change.
- **Not covered:** a token outside the list that the owner already approved to an allowed target (before or outside the module) can still be pulled by that target when the agent calls it; the module doesn't measure that token. Use a dedicated account for the agent, holding only the mandate's assets.
- **Vault equivalent, for #67:** a vault can be sent tokens outside its asset list, and the same approve-then-swap path moves them. Those tokens aren't part of NAV, so depositors don't count on them, but the vault rule should match the module's at the next deployment (it changes verdicts, so it needs a re-rating).
- **Revoking stays allowed:** `approve(x, 0)` and `setApprovalForAll(x, false)` on any token are not breaches (as on a vault), so the agent can clean up approvals without being frozen. `increaseAllowance` is never a revocation.
- **Tests:** `test_UnlistedTokenCantBeDrainedThroughAnAllowedTarget`, `test_TokenCallsOnUnlistedTokensAreUnauthorizedTargets`, `test_RevokingOnUnlistedTokensIsAllowed`, `test_UnlistedTokenCallsDifferByDesign`.

### F-18 (Medium) An account that only pretended to pay kept its policy alive for ever

Fixed. A contract that claims every execution succeeded made `payPremium` return without paying. CoverManager then failed to distribute money it never received, so `accrue` reverted: the policy was never marked past due, never lapsed or expired, couldn't be cancelled, and kept its cover counted against the pool's caps. The owner could switch to paying whenever a claim became worth it.

- **Fix:** CoverManager measures its base-asset balance around `payPremium` and treats any shortfall as a missed premium (the usual past-due, grace-period and lapse path). Vault premium transfers always arrive, so vault flows are unchanged.
- **Assumption:** the base asset moves exactly. A fee-on-transfer or rebasing base asset would make every premium look missed (USDG is neither).
- **Tests:** `test_PremiumThatNeverArrivesIsMissed`; invariant `PremiumAccrualNeverStalls`.

### F-19 (Low) Two modules could be installed on one account

Fixed. "One module in use per account" was checked only when a module was created. An account could create two modules before installing either, or reinstall an old one, and two modules recording the same outflow gave two paid claims for one transfer.

- **Fix:** `onInstall` reverts unless the module is the account's current one (`factory.moduleOf(account)`, the last it created).
- **Tests:** `test_OnlyTheAccountsCurrentModuleCanBeInstalled`; invariant `OneModulePerAccount`.

Also from the review: `CoverManager.setModuleFactory` is set once, so it now checks the factory's `vaultFactory()` is this deployment's vault factory (`WrongVaultFactory`). And predicting a module's address then changing the oracle doesn't half-install anything: Safe7579 refuses to install the empty predicted address (`test_InstallingAStalePredictionFails`).

Also: the agent's key must not also be an owner, validator or ERC-1271 signer of the account. If it is, it can sign approvals (Permit2-style signature transfers, for example) that the account honours without any call through the module. The contracts README says so; the module can't check it on every account type.

### F-11 (Medium) Monitor mode on a smart account reaches further than on a vault

In Monitor mode a breaching call still runs, as it does for a vault, but it runs with the smart account's authority. The module refuses calls to the account and to itself in both modes. It can't list every contract that trusts the account as caller: another installed module's settings (for example an owner-list validator) or an adapter. A compromised agent in Monitor mode could call one of those and change the account's setup. That is recorded as an UnauthorizedTarget breach with no loss and the agent is frozen; any later drain through the new setup happens outside the module.

- **Status:** accepted and documented. Since F-16's fix, Monitor-mode modules can't hold cover, so this only concerns the account's owner. Enforce mode blocks such calls before they run.

### F-12 (Low, by design) Deferred breaches on module-protected accounts aren't paid

The owner of a smart account can move funds without going through the module (a Safe owner's `execTransaction` doesn't pass through ERC-7579 hooks, and any other module or executor can move funds too). An unexplained drop can't be told apart from the owner withdrawing, and paying it would let the owner fake a loss and collect the pool's share of the payout. ClaimsEngine therefore refuses Deferred breaches on modules (`BreachNotCovered`); the module still records them and freezes the agent. The keeper marks them ignored with the reason.

- **Effect:** losses outside `execute` are not covered on a module, in either mode. In Enforce mode they still happen: approvals to allowed targets are allowed, so an allowed spender that is later compromised can pull funds (a Deferred loss that a vault's policy would pay). In Monitor mode, an approval to an unauthorized spender also goes through (recorded, agent frozen) and a later pull isn't covered either.

### F-13 (Informational) A Safe owner's own transactions skip the hook

Without the hook, an owner withdrawal looks like an unexplained drop at the next `execute`, `reconcile` or premium collection, which records a Deferred breach and freezes the agent. The owner calls `sync()` after moving funds that way (ideally in the same Safe transaction), or moves funds through Safe7579's `execute`, where the hook runs. Tested in `ModuleSafe7579.t.sol`.

### F-14 (Informational) F-03 applies to modules too

A payout that lands in the account while the agent's call is running counts as inflow and reduces the loss recorded for that call. Same preconditions and the same fix as F-03 (#67).

### F-15 (Informational) Safe7579 hides a failed target call's revert reason

Safe7579 reports a failed call as its own `ExecutionFailed()`, so `module.execute` on a Safe bubbles that instead of the target's revert data (the ERC-7579 reference account bubbles the original, as the vault does). Nothing is recorded either way. SDK error decoding should expect both.

### Other checks

| Item | Result |
|---|---|
| Only factory modules can hold cover, and only in Enforce mode | Yes: CoverManager checks `moduleFactory.isModule` and the module's mode; the module factory is set once and must serve this deployment's vault factory |
| Payouts reach the protected account | Yes: ClaimsEngine pays `module.account()`; invariant `ModulePayoutsReachTheAccount` (exercised through council-approved disputes) |
| The account owner can't collect a payout they caused | Monitor-mode modules can't be insured; Enforce blocks breaches through `execute`; Deferred isn't paid; disputes need the council (F-16) |
| Nobody can create a module for someone else's account | Yes: the caller is the account |
| One module installed per account | Yes: a new one can be created only once the previous one is uninstalled, and only the latest one created can be installed (F-19); invariant `OneModulePerAccount` |
| Premiums are counted only when they arrive | Yes (F-18); invariant `PremiumAccrualNeverStalls` |
| The agent can only act through `execute` | Yes: the session key has no rights on the account; `execute` refuses the account and the module as targets, and token calls on unlisted tokens are breaches (F-17) |
| The owner can always uninstall | Yes: `onUninstall` makes no external calls, and the hook lets the owner's actions through even if the oracle fails |
| Nothing else acts on the account during the agent's call | Yes, when the hook is installed: it refuses any other execution while `execute` is running |
| Reentrancy | `execute`, `reconcile`, `sync` and `payPremium` are `nonReentrant`; hook and install callbacks are account-only |
