# Day 3: Cover, bonds and claims

Plan reference: docs/PLAN.md Section 20, Day 3. Design record: `docs/decisions/003-cover-and-claims.md`.

## Done

- **`CoverPool`:**
  - ERC-4626 underwriting pool.
  - Withdrawals need a request, a 7-day cooldown and free capital. Capital locked by active cover at 2x leverage can't leave.
  - `payClaim` (ClaimsEngine only).
- **`OperatorBond`:**
  - First-loss stake per agent. The first staker becomes the operator.
  - Withdrawal has a cooldown and is blocked while the agent has active cover.
  - `slash` (ClaimsEngine only).
- **`CoverManager`:**
  - Binds cover from EIP-712 quotes signed by an attester.
  - Mints a non-transferable policy NFT to the vault.
  - Streams premiums from the vault, rounded up, split 15/5/80.
  - A missed premium starts a 3-day grace period with coverage continuing. After that the policy lapses. Policies expire at the end of the term.
  - Risk caps at binding: leverage, per-agent, tier and model family.
- **`ClaimsEngine`:**
  - Permissionless parametric claims with a 10% deductible and a 7-day claim window after a policy ends.
  - Unpaid premium is netted from the payout.
  - Waterfall: bond first, then pool, both paying into the vault.
- **Cross-language checks:**
  - The quote digest from viem matches `CoverManager.quoteDigest`.
  - The Solidity tier rules match the TypeScript table.
- **Tests:** 127 Forge tests, including fuzz tests at 1,024 runs in the CI profile, plus 43 TypeScript tests.

## Fixed in review

CodeRabbit found that a breach draining the vault's base asset made its own claim fail. The claim first collects the premium, which failed, which lapsed the policy backdated to before the breach. The fix is a grace period plus netting unpaid premium from the payout (ADR-003, decision 5). New tests:
- a full drain is paid
- a breach during the grace period is paid with the premium netted
- the grace period, lapse and debt behave as described

CodeRabbit's summary also flagged two limits I'd documented. Both are fixed:
- The operator bond now stays locked until the claim window after the agent's last policy has passed.
- A claim the pool can't pay in full now reverts instead of being finalized, so its breaches stay claimable.

## The demo loop, tested end to end

`test_FullLoop_BondPaysTheWholeClaim` and `test_FullLoop_BondThenPool`:
1. Bind 20,000 cover.
2. Wait out the waiting period.
3. The agent sends 5,000 to an attacker. The vault records the breach and freezes the agent.
4. Anyone files the claim, which pays 4,500 into the vault. That's either all from the bond, or 2,000 from the bond and 2,500 from the pool.

## Changes to the plan

PLAN.md Sections 6.2 and 6.4 were updated with what was built:
- vaults must freeze on breach
- the guardian binds cover
- policy NFTs can't be transferred
- the 30-day term, waiting period and claim window
- the tier-based agent cap

## Blockers

Unchanged: testnet RPC allowlisting (needed Day 4) and the Anthropic API key (needed Day 5).

## Next (Day 4)

`BondedRegistry` (ERC-8004 compatible, attester set), `DisputeModule`, `BountyBoard`, deploy scripts, and deployment to Robinhood Chain testnet and Arbitrum Sepolia.

## Review asks

- Check the remaining known limits in ADR-003 (operator fraud is priced, not prevented; a vault short of base asset loses cover after the grace period).
- Check the fee split (15% treasury, 5% bounty, 80% underwriters) and the 10% deductible.
