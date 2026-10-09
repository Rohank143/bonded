import { TIER_RULES, tierForScore, type Tier } from "@bondedhq/shared";
import type { MandateForm, MandateToken } from "./onboarding";
import { MANDATE_TOKENS } from "./onboarding";

/**
 * The bond and cover in plain words (launch items 3.3, 3.4 and 5.1): the bond each tier needs for
 * the cover wanted (the same minimum-bond rule `priceCover` enforces), a recommended cover amount,
 * and the suggested mandate's presets applied to the onboarding form.
 */

/** Smallest bond for `cover` at a tier: the tier's share, rounded up to a whole token. */
export function minimumBond(coverUsd: number, tier: Tier): number {
  const rule = TIER_RULES.find((r) => r.tier === tier)!;
  return Math.ceil((coverUsd * rule.minBondBps) / 10_000);
}

/** Each insurable tier's minimum bond for `cover`, grouped where tiers share a rule. */
export function bondTable(coverUsd: number): { tiers: string; minBondPct: number; bond: number }[] {
  const groups: { tiers: Tier[]; minBondBps: number }[] = [];
  for (const r of TIER_RULES.filter((t) => t.insurable)) {
    const last = groups.at(-1);
    if (last && last.minBondBps === r.minBondBps) last.tiers.push(r.tier);
    else groups.push({ tiers: [r.tier], minBondBps: r.minBondBps });
  }
  return groups.map((g) => ({
    tiers: g.tiers.length > 1 ? `${g.tiers.at(-1)} to ${g.tiers[0]}` : g.tiers[0]!,
    minBondPct: g.minBondBps / 100,
    bond: minimumBond(coverUsd, g.tiers[0]!),
  }));
}

/**
 * The bond to stake for the cover wanted. With a score (from a preview), its tier's minimum;
 * without one, the most any insurable tier asks, so the cover can be bought whatever the score.
 */
export function recommendedBond(
  coverUsd: number,
  score?: number | null,
): { bond: number; why: string } {
  if (score != null && Number.isInteger(score) && score >= 0 && score <= 100) {
    const rule = tierForScore(score);
    if (rule.insurable)
      return {
        bond: minimumBond(coverUsd, rule.tier),
        why: `your preview scored ${score} (tier ${rule.tier}), which needs a bond of ${rule.minBondBps / 100}% of the cover`,
      };
    return {
      bond: minimumBond(coverUsd, "B"),
      why: `your preview scored ${score} (tier ${rule.tier}), which can't be insured yet; this is what tier B would need`,
    };
  }
  const worst = TIER_RULES.filter((r) => r.insurable).reduce((a, b) =>
    b.minBondBps > a.minBondBps ? b : a,
  );
  return {
    bond: minimumBond(coverUsd, worst.tier),
    why: `without a score yet, this is the most any insurable tier asks (${worst.minBondBps / 100}% for tier ${worst.tier}), so the cover can be bought whatever it scores`,
  };
}

/**
 * The cover to buy: no more than the vault holds (cover pays for what's in it), the underwriting
 * policy's cap for this agent, and the testnet cap.
 */
export function recommendedCover(input: {
  vaultBalanceUsd: number | undefined;
  policyCapUsd?: number | undefined;
  testnetCapUsd: number;
}): { amount: number; limitedBy: "vault" | "policy" | "testnet" } | undefined {
  if (input.vaultBalanceUsd === undefined || input.vaultBalanceUsd <= 0) return undefined;
  const options: { amount: number; limitedBy: "vault" | "policy" | "testnet" }[] = [
    { amount: Math.floor(input.vaultBalanceUsd), limitedBy: "vault" },
    { amount: input.testnetCapUsd, limitedBy: "testnet" },
    ...(input.policyCapUsd !== undefined
      ? [{ amount: input.policyCapUsd, limitedBy: "policy" as const }]
      : []),
  ];
  return options.reduce((a, b) => (b.amount < a.amount ? b : a));
}

/** A premium rate on an amount, per year: what the quote's rate means in tokens. */
export const premiumPerYear = (coverUsd: number, rateBps: number) =>
  Math.round((coverUsd * rateBps) / 10_000);

/** What cover pays and what it doesn't, in plain words. */
export const COVER_COVERS = [
  "Losses from your agent breaking its mandate: a trade or transfer the mandate doesn't allow, because it was manipulated (a planted message, a fake price), malfunctioned, or one of its tools was compromised.",
];
export const COVER_EXCLUDES = [
  "Market losses from trades the mandate allows: a bad trade within the rules is not a breach.",
  "Your own keys being stolen: the guardian's or the owner's key, which can act outside the mandate.",
  "Bugs in other contracts: the exchange or a token the vault trades with.",
];
export const COVER_EXCLUDES_MODULE =
  "On a smart account's module: losses found only later (deferred breaches), which can't be told apart from the account's owner moving funds.";

/** The bond in plain words. */
export const BOND_EXPLAINED =
  "The bond is your own stake in the agent. If a claim against its cover is paid, the bond pays first, then the cover pool; so the bond is lost only when your agent breaks its mandate and someone is paid for it. Cover needs a bond of at least a share of the cover, set by the score's tier. A bigger bond also lowers the premium.";

/** GET …/suggested-mandate: what the agent actually used, and presets built from it. */
export interface MandatePreset {
  id: "conservative" | "active";
  label: string;
  /** In plain words, what the preset allows. */
  line?: string;
  mode: MandateForm["mode"];
  tokens: string[];
  maxTxUsd: number;
  maxDailyUsd: number;
}

export interface SuggestedMandate {
  /** Token symbols it traded in its passing check and preview. */
  tokens: string[];
  /** Contracts it called. */
  contracts: { address: string; label?: string | null }[];
  /** Its largest trade, in dollars, if it traded. */
  largestTradeUsd: number | null;
  presets: MandatePreset[];
  /** Where it came from, in a sentence (e.g. "your passing check and preview p1"). */
  basis?: string | null;
}

export const PRESET_LABELS = {
  conservative: "Conservative trader",
  active: "Active trader",
  custom: "Custom",
} as const;
export type PresetChoice = keyof typeof PRESET_LABELS;

/** A preset's fields for the onboarding form; tokens the vault can't hold are dropped. */
export function applyPreset(p: MandatePreset): {
  mode: MandateForm["mode"];
  tokens: MandateToken[];
  maxTx: string;
  maxDaily: string;
} {
  return {
    mode: p.mode,
    tokens: MANDATE_TOKENS.filter((t) => p.tokens.includes(t)),
    maxTx: String(p.maxTxUsd),
    maxDaily: String(p.maxDailyUsd),
  };
}
