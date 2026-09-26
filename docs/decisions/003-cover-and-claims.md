# ADR-003: Cover, bonds and claims

- **Status:** Accepted
- **Date:** 2026-09-27
- **Code:** `contracts/evm/src/CoverPool.sol`, `OperatorBond.sol`, `CoverManager.sol`, `ClaimsEngine.sol`

## Context

Day 2 gave us a vault whose breach log records what an agent did wrong and what it cost. Day 3 turns that log into money: operators post a bond, underwriters supply capital, an attester-signed quote binds cover, premiums stream from the vault, and claims pay automatically.

## Decisions

### 1. Quotes are signed off-chain and verified on-chain

The Arena prices the risk off-chain and the attester signs an EIP-712 `Quote`. CoverManager checks:
- the signature
- that the quote hasn't expired and hasn't been used before
- that the quote matches the vault it's for (agent id, mandate hash, base asset)

The heavy maths stays off-chain; the contract enforces the result and the risk caps. A cross-language test pins the digest: viem and `CoverManager.quoteDigest` must agree.

### 2. The guardian binds cover, and the vault pays

Premiums come out of the vault's own assets, like a management fee, so depositors pay for the protection they get. Only the vault's guardian (the operator) can bind cover. The policy NFT is minted to the vault and can't be transferred: it is a receipt, not a tradeable claim.

### 3. Only vaults that freeze on breach can be covered

The payout lands in the vault. If the compromised agent could keep acting, it could drain the payout too. Requiring `freezeOnBreach` means the agent is stopped until the guardian rotates its key.

### 4. Fixed 30-day term with a waiting period

Scores expire, so cover does too. The term matches the attestation lifetime. Breaches in the first `waitingPeriod` (1 day by default, configurable down to minutes for the demo) aren't covered. That stops "insure after you've already been hit". Each policy stores its own term and waiting period, so later parameter changes don't affect it.

### 5. Premiums stream and round up

`accrue` is permissionless. It charges `cover x rate x elapsed / year`, rounded **up**, so calling it every block can't round the premium down to zero. If the vault can't pay, the policy **lapses** at the time it was last paid up to, and breaches after that aren't covered. Past the end of the term it **expires**.

Premiums are split 15% to the treasury, 5% to the bounty pool and 80% to the underwriting pool, where they raise the share price.

### 6. Risk caps at binding

Three caps, each measured against pool assets:
- total cover ≤ 2x pool assets (leverage)
- one agent ≤ the smaller of 10% and its tier cap
- one model family ≤ 40%

The family cap is the correlation control: one new jailbreak can hit every agent on the same model.

### 7. Underwriters can't run ahead of a claim

Withdrawing from CoverPool needs:
- a request
- a 7-day cooldown
- a matured request used within 2 days, so it can't be kept open as a standing option
- enough free capital, i.e. capital not locked by active cover at the allowed leverage

### 8. Claims are parametric and permissionless

Anyone can call `fileClaim(policyId, breachIds)`; the keeper does it within seconds. For each breach, the engine checks:
- it was recorded by the covered vault
- it hasn't been claimed
- it wasn't blocked (blocked breaches lost nothing)
- it falls inside the coverage window

Then:
- **Payout** = min(remaining cover, loss × (1 − 10% deductible)).
- **Waterfall:** slash the operator bond first, then the pool pays the rest.
- **Destination:** both pay into the vault, restoring the share price for every depositor.
- **Remaining cover:** it shrinks by what was paid, and a policy with none left is **exhausted**.

The engine settles premiums before checking coverage, so a policy that should have lapsed can't be claimed on as if it were still active.

### 9. Claims can arrive after a policy ends

Breaches inside the coverage window can still be claimed for 7 days after the policy ends.

## Known limits

- **Operator fraud is priced, not prevented.** A dishonest operator who drains their own vault to a colluding address loses their bond first. If the bond is smaller than the payout, the pool covers the rest; depositors are made whole minus the deductible. Tier minimum bonds, per-agent caps and the waiting period limit this.
- **Lapse griefing.** If a vault holds almost no base asset (e.g. everything is in Stock Tokens), anyone can call `accrue` and lapse its cover. Operators should keep a base-asset buffer. A grace period is a possible improvement.
- **Pool shortfalls aren't carried forward.** If the pool can't pay a claim in full, the shortfall isn't recorded as a debt.
- **Bond withdrawal after expiry.** The bond can be withdrawn once an agent has no active cover. A breach near the end of a term could be claimed after the bond is gone if nobody files the claim promptly. The keeper files claims immediately; tying withdrawals to the claim window is a Day 13 candidate.
- **Attesters are managed by CoverManager's owner.** They move to BondedRegistry on Day 4.
