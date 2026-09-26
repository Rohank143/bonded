# ADR-002: Mandate Vault design

- **Status:** Accepted
- **Date:** 2026-09-27
- **Code:** `contracts/evm/src/MandateVault.sol`, `MandateVaultFactory.sol`, `oracles/`

## Context

The Mandate Vault is the heart of Bonded. It holds the agent's funds, and its breach log is what the Arena judges on and what ClaimsEngine pays against. It has to be hard to fool, cheap to reason about, and identical in the sandbox and in production.

## Decisions

### 1. Two kinds of check: before the call and after it

- **Before (T1):** decode what the call *asks* for. That covers the target and selector, the approval spender, and the transfer recipient.
- **After (T3, T2):** measure what the call *did*. We compare every allowed asset's balance before and after the call and price the difference with the oracle.

The after-check is the safety net. However an attack routes value out (a router with the attacker as recipient, a honeypot token, a nested multicall), the vault sees value leave without equivalent allowed assets coming back. Decoding every router's calldata would never be complete; measuring balances always is.

### 2. T3 means "value leaked", measured against `maxSlippageBps`

We can't enumerate every token the vault might receive, so T3 isn't "received a non-allowed token". It is "net loss above `maxSlippageBps` of the outflow". A honeypot or lookalike swap loses ~100% and trips it. A fair swap loses a few basis points and doesn't. This adds `maxSlippageBps` to the mandate (TypeScript and Solidity).

Allowed transfers to `destinations` skip this check, since that value is meant to leave. They still count toward T2 limits.

### 3. One breach per action, precedence T1 > T3 > T2

An action that breaks several rules records one breach with the net loss. ClaimsEngine can then sum losses across breaches without double-counting.

### 4. Enforce mode records blocked attempts instead of reverting

A plain revert would erase the evidence. Instead:
- **T1 breaches:** the call is skipped.
- **T2/T3 breaches:** the call runs inside a self-call (`measuredCall`), which reverts with `BreachDetected`. `execute` catches that, records a *blocked* breach (loss 0) and freezes the agent.

Target failures are wrapped in `CallFailed`, so a malicious target can't fake `BreachDetected`. Genuine target reverts bubble up unchanged.

### 5. `reconcile` runs before every balance-changing entry point

Deposits, withdrawals, premium payments and `execute` all call `reconcile` first, then re-snapshot balances afterwards. Otherwise a drop caused outside `execute` (e.g. a compromised router spending an allowance) could be painted over by the next deposit. Anyone can also call `reconcile` directly; the keeper will do so periodically.

### 6. Full deployments, not clones

OpenZeppelin's ERC-4626 stores its asset as an immutable set in the constructor, which doesn't work with minimal-proxy clones without the upgradeable variant. Full deployments are simpler and avoid initializer pitfalls. The cost is higher deployment gas, which is fine on L2s and testnets. The factory is 21.6 KB, under the 24 KB limit.

### 7. Guardian can freeze, unfreeze and rotate, but never move funds

The guardian (the operator) manages the agent key. It has no path to the vault's assets, which keeps the operator-fraud surface small.

### 8. Depositors can always exit while the agent is frozen

Freezing stops only `execute`. Withdrawals are paid in the base asset and capped by its balance (`maxWithdraw` / `maxRedeem`).

### 9. Other choices

- **ERC-20 only:** `execute` takes no native value, and the vault doesn't track ETH. Less to get wrong.
- **Set-once modules:** CoverManager and ClaimsEngine addresses on the factory are set once, so the owner can't later redirect premium pulls or claim marking.
- **Inflation attack:** a virtual share offset of 6 decimals guards against the ERC-4626 inflation attack.
- **Chainlink adapter:** checks staleness per feed and the L2 sequencer uptime feed, with a 1 hour grace period.

## Known limits

- **Fixed 24h window.** The daily limit resets 24h after the window starts. An agent could spend a full day's limit just before a reset and again just after. A rolling window can come later.
- **`maxDrawdownBps` isn't enforced on-chain.** It feeds T4 (dispute) claims.
- **Stale oracles pause the vault.** Deposits, withdrawals and `execute` all revert rather than use a bad price. An in-kind emergency exit is a candidate for Day 13 hardening.
- **Some tokens can't be allowed assets.** Rebasing and fee-on-transfer tokens would create false breaches.
