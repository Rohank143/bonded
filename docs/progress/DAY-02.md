# Day 2: Mandate Vault

Plan reference: docs/PLAN.md Section 20, Day 2. Design record: `docs/decisions/002-mandate-vault.md`.

## Done

- **`MandateVault`:**
  - ERC-4626 vault priced across all allowed assets.
  - `execute` for the agent, with T1 checks before the call and T3/T2 checks after it (oracle-priced balance changes).
  - Monitor and Enforce modes. Enforce rolls back breaching calls but keeps a record of the attempt.
  - `reconcile` for losses that happen outside `execute`.
  - Freeze, unfreeze and rotate for the guardian.
  - `payPremium` (CoverManager only) and `markBreachClaimed` (ClaimsEngine only).
- **`MandateVaultFactory`:** deploys vaults and tracks `isVault`. CoverManager and ClaimsEngine addresses are set once.
- **Oracles:** `MockOracle` for testnets and demos; `ChainlinkOracle` with staleness and L2 sequencer checks.
- **Shared schema:** added `maxSlippageBps` to mandate limits (TypeScript and Solidity). 42 TypeScript tests.
- **Tests:** 67 Forge tests, including fuzz tests at 1,024 runs in the CI profile:
  - every breach type in both modes
  - one breach per action and the precedence rules
  - a deferred loss that a later deposit can't hide
  - reentrancy blocked
  - failed calls bubble their revert
  - guardian and module access control
  - NAV and withdrawal caps
  - oracle math and failure modes
  - factory validation

## Changes to the plan

- T3 is now defined as "value leaked beyond `maxSlippageBps`" rather than "received a non-allowed token", because the vault can't enumerate unknown tokens. It catches honeypots, lookalikes and swaps sent to the attacker.
- The factory deploys full vaults instead of clones (ADR-002, decision 6).
- Docs/PLAN.md Sections 6.1–6.3 were updated to match.

## Blockers

Unchanged from Day 1: testnet RPC allowlisting (needed Day 4) and the Anthropic API key (needed Day 5).

## Next (Day 3)

`CoverPool`, `OperatorBond`, `CoverManager` (EIP-712 quotes, policy NFT, premium streaming, caps) and `ClaimsEngine` (waterfall), with the full integration test: bind cover, breach, claim, bond slashed, pool pays, vault restored.

## Review asks

- Check the breach definitions in ADR-002, especially T3 and the one-breach-per-action rule. They decide what gets paid.
- Check the known limits list. Anything there you'd want fixed before the demo?
