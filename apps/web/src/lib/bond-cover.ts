import { TIER_RULES, tierForScore, type EvmMandateRules, type Tier } from "@bondedhq/shared";
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

/**
 * GET …/suggested-mandate (`SuggestedMandate` in @bondedhq/shared): what the agent actually used
 * in its passing check and its preview or rating, and two presets built from it. There is no
 * "custom" preset from the API: custom is the owner's edit of either.
 */
export interface MandatePreset {
  id: "conservative" | "active";
  label: string;
  /** In plain words, what the preset allows. */
  line?: string;
  mode: MandateForm["mode"];
  /** Token symbols it allows besides the base asset (e.g. "tNVDA"). */
  tokens: string[];
  maxTxUsd: number;
  maxDailyUsd: number;
  /** The whole draft with addresses (`rules.assets` etc.), for building the mandate. */
  rules?: PresetRules;
}

/** A preset's whole draft: `MandateDraft` in @bondedhq/shared (the mandate's rules, no agent id). */
export type PresetRules = Partial<Omit<EvmMandateRules, "agentId">>;

export interface SuggestionBasis {
  sources: ("check" | "preview" | "rating")[];
  trades: number;
  tokens: string[];
  largestTradeUsd: number;
  usedRouter: boolean;
  transfers: number;
  approvals: number;
}

export interface SuggestedMandate {
  /** Token symbols it traded, besides the base asset. */
  tokens: string[];
  /** Contracts it called through the vault. */
  contracts: { address: string; label?: string | null }[];
  /** Its largest trade, in dollars; null when no trade was seen. */
  largestTradeUsd: number | null;
  presets: MandatePreset[];
  /** The preset the API recommends. */
  recommended?: MandatePreset["id"];
  /** Things the owner has to decide, in plain words. */
  notes?: string[];
  /** What the suggestion was built from. */
  basis?: SuggestionBasis | null;
}

const SOURCE_WORDS = { check: "your passing check", preview: "your preview", rating: "its rating" };

/** "your passing check and your preview (3 trades)": where a suggestion came from. */
export function basisLine(basis: SuggestionBasis | null | undefined): string | undefined {
  if (!basis?.sources.length) return undefined;
  const words = basis.sources.map((s) => SOURCE_WORDS[s] ?? s);
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
  return `${list} (${basis.trades} trade${basis.trades === 1 ? "" : "s"})`;
}

export const PRESET_LABELS = {
  conservative: "Conservative trader",
  active: "Active trader",
  custom: "Custom",
} as const;
export type PresetChoice = keyof typeof PRESET_LABELS;

/** What a preset sets in the onboarding form, and in the mandate it submits. */
export interface PresetFields {
  mode: MandateForm["mode"];
  /** The tokens shown; tokens the vault can't hold are dropped. */
  tokens: MandateToken[];
  maxTx: string;
  maxDaily: string;
  /** In percent; undefined when the preset doesn't say (the form keeps its own). */
  drawdown?: string;
  slippage?: string;
  /** The preset's own rules, carried into the mandate as they are (the form has no field for
   *  targets, and `assets` are the addresses the API chose, not looked up from symbols). */
  destinations?: string[];
  assets?: string[];
  targets?: NonNullable<MandateForm["targets"]>;
}

/**
 * A preset for the onboarding form: everything its rules set (assets, targets, destinations, the
 * limits, slippage, drawdown and mode), so the mandate submitted is the one the preset shows.
 */
export function applyPreset(p: MandatePreset): PresetFields {
  const r = p.rules ?? {};
  return {
    mode: r.mode ?? p.mode,
    tokens: MANDATE_TOKENS.filter((t) => p.tokens.includes(t)),
    maxTx: String(r.maxTradeUsd ?? p.maxTxUsd),
    maxDaily: String(r.maxDailyUsd ?? p.maxDailyUsd),
    ...(r.maxDrawdownPct !== undefined ? { drawdown: String(r.maxDrawdownPct) } : {}),
    ...(r.maxSlippagePct !== undefined ? { slippage: String(r.maxSlippagePct) } : {}),
    ...(r.destinations ? { destinations: [...r.destinations] } : {}),
    ...(r.assets ? { assets: [...r.assets] } : {}),
    ...(r.targets
      ? {
          targets: r.targets.map((t) => ({
            address: t.address,
            ...(t.functions ? { functions: [...t.functions] } : {}),
          })),
        }
      : {}),
  };
}
