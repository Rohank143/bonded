import { type TypedDataDomain, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bondDiscountedPremium, priceExpectedLoss } from "./actuarial.js";
import { type Attestation, bondedDomain, Quote, quoteTypedData } from "./schemas/attestation.js";
import { isTeeMeasurement } from "./tee.js";
import { type Tier, tierForScore } from "./tiers.js";

/**
 * Cover quotes: priced from a signed attestation, signed by the attester, and accepted by
 * `CoverManager.buyCover` (docs/SPECIFICATION.md Sections 6.4 and 9, ADR-009).
 *
 * The quote is priced only from the attestation's expected loss and the operator's bond, so
 * anyone holding the attestation can recompute the premium and check it.
 */

/** Quotes stay valid for an hour: long enough to sign and send `buyCover`, short enough that
 *  a price can't be held while the agent's risk changes. */
export const QUOTE_TTL_SECONDS = 60 * 60;

const BPS = 10_000n;

export interface QuotePricing {
  tier: Tier;
  /** Annual premium rate after the bond discount, in basis points (rounded up). */
  premiumRateBps: number;
  /** Premium rate before the bond discount, in basis points (rounded up). */
  basePremiumRateBps: number;
  /** Smallest bond for the agent's total cover (existing plus this quote): the tier's share,
   *  rounded up. Goes into the quote's `minBond`, which `buyCover` enforces. */
  minBond: bigint;
  /** bond ÷ the agent's total cover, as used for the discount. */
  bondRatio: number;
}

/**
 * Prices cover for a rated agent (Section 9.1):
 *   P = EL · (1 + load) + capital, then the bond discount P · (1 − min(0.30, bond ÷ cover − 0.10)).
 *
 * The bond belongs to the agent, not the vault, and one agent can hold cover on several vaults.
 * So the bond is measured against the agent's total cover (`existingCover` plus this quote):
 * one bond can't earn the full discount, or meet the minimum, on every vault at once.
 *
 * Throws when the score is uninsurable or the bond is below the tier's minimum, since
 * `buyCover` would reject the quote anyway.
 */
export function priceCover(input: {
  expectedLossBps: number;
  score: number;
  coverAmount: bigint;
  bond: bigint;
  /** The agent's active cover on other policies (`CoverManager.activeCoverOfAgent`). */
  existingCover?: bigint;
}): QuotePricing {
  const { coverAmount, bond } = input;
  const existingCover = input.existingCover ?? 0n;
  if (coverAmount <= 0n) throw new RangeError("cover amount must be positive");
  if (existingCover < 0n) throw new RangeError("existing cover can't be negative");
  const rule = tierForScore(input.score);
  if (!rule.insurable) throw new QuoteError(`score ${input.score} (${rule.tier}) is uninsurable`);

  const totalCover = existingCover + coverAmount;
  const minBond = ceilDiv(totalCover * BigInt(rule.minBondBps), BPS);
  if (bond < minBond) {
    throw new QuoteError(
      `the operator bond (${bond}) is below the ${rule.tier} minimum of ${minBond} for the agent's total cover`,
    );
  }

  const base = priceExpectedLoss(input.expectedLossBps / 10_000).premiumRate;
  // Six decimal places is exact enough for a ratio that only moves the discount between 0 and 30%.
  const bondRatio = Number((bond * 1_000_000n) / totalCover) / 1_000_000;
  const discounted = bondDiscountedPremium(base, bondRatio);
  return {
    tier: rule.tier,
    premiumRateBps: toRateBps(discounted),
    basePremiumRateBps: toRateBps(base),
    minBond,
    bondRatio,
  };
}

/**
 * How firmly a score is tied to the code that runs (bring your own agent):
 * - tee: the rated code proved, with a TEE quote at every episode, that it is what runs, and the
 *   attestation carries its measurement;
 * - declared: the operator says which code it is (`codeHash`), and nothing checks it.
 */
export type BindingLevel = "declared" | "tee";

/** The binding of an attestation: `tee` when it carries a TEE measurement. */
export function bindingOf(teeMeasurement: string): BindingLevel {
  return isTeeMeasurement(teeMeasurement) ? "tee" : "declared";
}

/**
 * Underwriting policy, not score: the most cover one operator-run agent can hold in total, in
 * tUSDG, by binding. A declared agent's score may describe different code from what trades, so
 * the pool takes less of that risk. Configurable per API (`createApi`'s `coverCaps`).
 */
export const UNDERWRITING_COVER_CAP_USD: Readonly<Record<BindingLevel, number>> = {
  declared: 5_000,
  tee: 20_000,
};

/**
 * Why the policy refuses `coverAmount` on top of `existingCover` for an agent with this binding,
 * or undefined when it fits. Amounts are in base-asset units (6 decimals).
 */
export function underwritingCapRefusal(input: {
  binding: BindingLevel;
  coverAmount: bigint;
  existingCover?: bigint;
  caps?: Readonly<Record<BindingLevel, number>>;
}): string | undefined {
  const caps = input.caps ?? UNDERWRITING_COVER_CAP_USD;
  const cap = BigInt(Math.floor(caps[input.binding])) * 1_000_000n;
  if ((input.existingCover ?? 0n) + input.coverAmount <= cap) return undefined;
  const label = input.binding === "tee" ? "a TEE-bound agent" : "an agent with a declared binding";
  return `underwriting policy: cover for ${label} is capped at ${caps[input.binding].toLocaleString("en-US")} tUSDG in total`;
}

export interface BuildQuoteInput {
  /** The agent's current attestation. The quote copies its score, hashes and model family. */
  attestation: Attestation;
  vault: `0x${string}`;
  /** Cover in base-asset units (6 decimals for USDC-like assets). */
  coverAmount: bigint;
  /** The operator's bond for this agent now, in base-asset units. */
  bond: bigint;
  /** The agent's active cover on other policies (`CoverManager.activeCoverOfAgent`). */
  existingCover?: bigint;
  /** Unix seconds. Defaults to the current time. */
  now?: number;
  /** Defaults to a random 128-bit number. */
  nonce?: bigint;
  ttlSeconds?: number;
  /**
   * The operator-run agent's binding, when the underwriting cap applies (bring-your-own agents).
   * Omitted for Bonded's built-in designs, which keep the pool's own capacity limits only.
   */
  binding?: BindingLevel;
  /** Caps by binding (default `UNDERWRITING_COVER_CAP_USD`). */
  coverCaps?: Readonly<Record<BindingLevel, number>>;
}

/**
 * Builds an unsigned quote from an attestation. The quote expires after `ttlSeconds`, and never
 * after the attestation does, so a quote can't outlive the rating it was priced from.
 */
export function buildQuote(input: BuildQuoteInput): { quote: Quote; pricing: QuotePricing } {
  const { attestation } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (attestation.expiresAt <= now) throw new QuoteError("the attestation has expired");
  if (input.binding) {
    const refusal = underwritingCapRefusal({
      binding: input.binding,
      coverAmount: input.coverAmount,
      existingCover: input.existingCover ?? 0n,
      ...(input.coverCaps ? { caps: input.coverCaps } : {}),
    });
    if (refusal) throw new QuoteError(refusal);
  }

  const pricing = priceCover({
    expectedLossBps: attestation.expectedLossBps,
    score: attestation.score,
    coverAmount: input.coverAmount,
    bond: input.bond,
    existingCover: input.existingCover,
  });
  const quote = Quote.parse({
    agentId: attestation.agentId,
    vault: input.vault,
    coverAmount: input.coverAmount.toString(),
    premiumRateBps: pricing.premiumRateBps,
    score: attestation.score,
    modelFamily: attestation.modelFamily,
    mandateHash: attestation.mandateHash,
    reportHash: attestation.reportHash,
    minBond: pricing.minBond.toString(),
    expiresAt: Math.min(now + (input.ttlSeconds ?? QUOTE_TTL_SECONDS), attestation.expiresAt),
    nonce: (input.nonce ?? randomNonce()).toString(),
  });
  return { quote, pricing };
}

export interface SignedQuote {
  quote: Quote;
  signature: `0x${string}`;
  signer: `0x${string}`;
  chainId: number;
  /** The CoverManager the quote is signed for (the EIP-712 verifying contract). */
  coverManager: `0x${string}`;
}

export async function signQuote(
  quote: Quote,
  options: { chainId: number; coverManager: `0x${string}`; attesterKey: `0x${string}` },
): Promise<SignedQuote> {
  const account = privateKeyToAccount(options.attesterKey);
  const signature = await account.signTypedData(quoteTypedData(quoteDomain(options), quote));
  return {
    quote: Quote.parse(quote),
    signature,
    signer: account.address,
    chainId: options.chainId,
    coverManager: options.coverManager,
  };
}

/**
 * Checks a signed quote offline: the signer must be one of `trustedAttesters` (for example,
 * the registry's attesters) and the signature must be valid. The `signer` field travels with
 * the quote, so checking the signature alone would accept a quote anyone signed for themselves.
 */
export async function verifyQuote(
  signed: SignedQuote,
  trustedAttesters: readonly `0x${string}`[],
): Promise<boolean> {
  const trusted = trustedAttesters.some((a) => a.toLowerCase() === signed.signer.toLowerCase());
  if (!trusted) return false;
  return verifyTypedData({
    address: signed.signer,
    signature: signed.signature,
    ...quoteTypedData(quoteDomain(signed), signed.quote),
  });
}

/** A quote that can't be issued (uninsurable score, bond too small, expired attestation). */
export class QuoteError extends Error {
  override name = "QuoteError";
}

function quoteDomain(o: { chainId: number; coverManager: `0x${string}` }): TypedDataDomain {
  return bondedDomain(o.chainId, o.coverManager);
}

/** Rounds up, so rounding never undercharges the pool. */
function toRateBps(rate: number): number {
  // Strip float noise first (0.0156 * 10_000 = 156.00000000000003 must not become 157).
  return Math.min(10_000, Math.ceil(Number((rate * 10_000).toFixed(6))));
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);
}
