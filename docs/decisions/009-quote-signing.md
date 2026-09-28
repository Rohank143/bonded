# ADR-009: Cover quotes

- **Status:** Accepted
- **Date:** 2026-09-28
- **Code:** `packages/shared/src/quote.ts`, `packages/shared/test/quote.test.ts`, `apps/arena/test/quote.int.test.ts`

## Context

Day 6 produced a signed attestation: score, expected loss, report hash. To bind cover, `CoverManager.buyCover(quote, signature)` needs a second signed message, the quote (plan Section 6.4). Quote signing was deferred from Day 6 to Day 7. The API (`POST /quotes`), the Arena worker and the Gate 1 end-to-end run all need it, so it lives in `@bonded/shared` next to the EIP-712 types.

## Decisions

### 1. A quote is priced only from the attestation and the bond

`buildQuote` takes the agent's attestation, the vault, the cover amount, the operator's bond and the agent's existing cover, and nothing else:
- **score, model family, mandate hash, report hash:** copied from the attestation.
- **Premium:** Section 9.1. Base rate `EL × 1.3 + 0.8%`, from the attestation's `expectedLossBps`. Then the bond discount `× (1 − min(0.30, bond ratio − 0.10))`.
- **Rounding:** premium basis points round **up**, so rounding never undercharges the pool. The rounding ignores float noise: 0.3% EL prices at exactly 119 bps, not 120.

Anyone with the attestation can recompute the premium and check it.

The attestation stores expected loss in whole basis points. So a quote's base rate can differ from the report's by up to 1 bp. The quote is the one that counts, and it's reproducible from what was signed.

### 2. The bond is measured against the agent's total cover

The bond belongs to the agent, but one agent can hold cover on several vaults. If each quote compared the bond with its own cover only, one bond could earn the full discount and meet the tier minimum on every vault at once.

So `priceCover` measures the bond against **existing cover plus the new quote**. The caller passes the existing cover, read from `CoverManager.activeCoverOfAgent`.

The resulting minimum bond goes into the quote's `minBond` field. `buyCover` already enforces `bond ≥ max(quote.minBond, tier share of this cover)`, so the aggregate check is enforced on-chain, not just off-chain. The anvil test proves it: a quote whose `minBond` is above the staked bond reverts with `InsufficientBond`.

### 3. Refuse early what `buyCover` would reject

`buildQuote` throws a `QuoteError` instead of signing when:
- the score is uninsurable (CCC);
- the bond is below the tier's minimum for the agent's total cover;
- the attestation has expired.

The API can then return a clear reason instead of a quote that fails on-chain.

It doesn't check the pool's capacity, per-agent and model-family caps. Those depend on live pool state and are checked by `buyCover`. The API reads them before quoting (Day 7, API branch).

### 4. Short-lived, single-use, bound to one chain and CoverManager

- **Expiry:** one hour (`QUOTE_TTL_SECONDS`), and never later than the attestation's expiry.
- **Nonce:** a random 128-bit number by default. `buyCover` marks each quote digest as used, so a signed quote binds cover once.
- **Domain:** the EIP-712 domain is `Bonded`, version `1`, the chain id and the CoverManager address. A quote signed for one chain or deployment is invalid on another.

### 5. Verification needs a trusted signer list

`verifyQuote` returns true only if the signer is in the caller's trusted attester list **and** the signature is valid. It follows the same rule as `verifyAttestation`: the `signer` field travels with the quote, so the signature alone proves nothing.

## Consequences

- **Tested against the real contract:** on an anvil chain deployed by the production deploy script:
  - the TypeScript EIP-712 digest equals `CoverManager.quoteDigest`;
  - a TypeScript-signed quote binds cover at the quoted terms (84 bps for the plan's hardened agent with a 50% bond);
  - `buyCover` rejects:

| Case | Revert |
|---|---|
| Quote signed by a non-attester | `NotAttester` |
| Quote changed after signing | `NotAttester` |
| Expired quote | `QuoteExpired` |
| Replayed quote | `QuoteAlreadyUsed` |
| Bond below `minBond` | `InsufficientBond` |

- **The attester is trusted for price.** `buyCover` checks the signature, the vault and the caps, but it doesn't recompute the premium or compare the quote's score with the registry. A leaked attester key could sign cheap cover. The controls are the ones in plan Section 17: short expiry, nonces, the risk caps, and an attester set behind the registry owner.
- **The contract's own bond check is per quote.** It only aggregates across policies through `minBond`, so it relies on the attester setting `minBond` for the total. Checking the aggregate on-chain would mean tracking bond commitments per agent in `CoverManager`. That's a contract change, left for after Gate 1.
