import type { EvmMandateRules } from "./mandate-rules.js";

/**
 * A suggested mandate from what an agent actually did in its passing connection check and its
 * preview (or rating) episodes: the tokens it traded, the contracts it called and its largest
 * trade, with headroom. Deterministic; the owner reviews and edits it before creating the vault.
 */

/** What an agent did in one or more episodes, from their traces (only actions with no breach). */
export interface TradingSummary {
  /** Writes that went through the vault without a breach. */
  trades: number;
  /** Token symbols it traded (tUSDG, tNVDA, ...), sorted. */
  tokens: string[];
  /** It called the exchange's swap function. */
  usedRouter: boolean;
  transfers: number;
  approvals: number;
  /** Largest value one action moved out of the vault, in USD (the vault's own measure). */
  largestTradeUsd: number;
  /** Total moved out, in USD. */
  totalOutflowUsd: number;
}

export const EMPTY_TRADING: TradingSummary = {
  trades: 0,
  tokens: [],
  usedRouter: false,
  transfers: 0,
  approvals: 0,
  largestTradeUsd: 0,
  totalOutflowUsd: 0,
};

/** Several summaries as one. */
export function mergeTrading(list: readonly (TradingSummary | null | undefined)[]): TradingSummary {
  const all = list.filter((t): t is TradingSummary => Boolean(t));
  return {
    trades: all.reduce((n, t) => n + t.trades, 0),
    tokens: [...new Set(all.flatMap((t) => t.tokens))].sort(),
    usedRouter: all.some((t) => t.usedRouter),
    transfers: all.reduce((n, t) => n + t.transfers, 0),
    approvals: all.reduce((n, t) => n + t.approvals, 0),
    largestTradeUsd: Math.max(0, ...all.map((t) => t.largestTradeUsd)),
    totalOutflowUsd: all.reduce((n, t) => n + t.totalOutflowUsd, 0),
  };
}

export type MandatePreset = "conservative" | "active";

/** Headroom over the largest observed trade for each preset's per-trade cap. */
export const PRESET_HEADROOM: Readonly<Record<MandatePreset, number>> = {
  conservative: 1.25,
  active: 2,
};

/** The per-trade cap used when no trade was observed, in USD (the Arena demo mandate's per-trade cap). */
export const DEFAULT_TRADE_CAP_USD = 5_000;

/** A mandate draft: `EvmMandateRules` without the agent id, which onboarding fills in. */
export type MandateDraft = Omit<EvmMandateRules, "agentId">;

export interface SuggestedMandate {
  basis: {
    sources: ("check" | "preview" | "rating")[];
    trades: number;
    tokens: string[];
    largestTradeUsd: number;
    usedRouter: boolean;
    transfers: number;
    approvals: number;
  };
  /** Token symbols the agent traded (besides the base asset, which is always allowed). */
  tokens: string[];
  /** Contracts it called through the vault. */
  contracts: { address: string; label?: string }[];
  /** Largest value one action moved out, in USD; null when no trade was seen. */
  largestTradeUsd: number | null;
  /** Things the owner has to decide, in plain words. */
  notes: string[];
  recommended: MandatePreset;
  /** "Custom" is the owner's edit of either. */
  presets: SuggestedPreset[];
}

export interface SuggestedPreset {
  id: MandatePreset;
  label: string;
  /** One line saying what it is. */
  line: string;
  mode: "enforce";
  /** Token symbols it allows (besides the base asset). */
  tokens: string[];
  maxTxUsd: number;
  maxDailyUsd: number;
  /** The whole draft, addresses and all, for `buildEvmMandate` once the agent id is known. */
  rules: MandateDraft;
}

/** Round up to a whole hundred dollars, at least 100. */
const roundCap = (usd: number) => Math.max(100, Math.ceil(usd / 100) * 100);

export function suggestMandate(input: {
  chainId: number;
  /** The deployment's market: base asset (usdg), tokens and router. */
  market: { usdg: string; router: string; tokens: Readonly<Record<string, string>> };
  trading: TradingSummary;
  sources: SuggestedMandate["basis"]["sources"];
}): SuggestedMandate {
  const { trading, market } = input;
  const symbolAddress = (symbol: string) =>
    market.tokens[symbol] ?? market.tokens[symbol.replace(/^t/, "")] ?? undefined;
  const observed = trading.tokens
    .map((s) => symbolAddress(s))
    .filter((a): a is string => Boolean(a) && a!.toLowerCase() !== market.usdg.toLowerCase());
  const everyToken = Object.values(market.tokens).filter(
    (a) => a.toLowerCase() !== market.usdg.toLowerCase(),
  );
  const largest = trading.largestTradeUsd;
  const cap = (headroom: number) =>
    largest > 0 ? roundCap(largest * headroom) : DEFAULT_TRADE_CAP_USD;
  const conservativeCap = cap(PRESET_HEADROOM.conservative);
  const activeCap = cap(PRESET_HEADROOM.active);
  const router = [{ address: market.router, functions: ["swap(address,address,uint256,address)"] }];
  const common = {
    chainId: input.chainId,
    mode: "enforce" as const,
    baseAsset: market.usdg,
    targets: router,
    destinations: [] as string[],
    freezeOnBreach: true,
  };
  const conservative: MandateDraft = {
    ...common,
    assets: observed.length ? observed : everyToken,
    maxTradeUsd: conservativeCap,
    maxDailyUsd: conservativeCap * 4,
    maxDrawdownPct: 10,
    maxSlippagePct: 1,
    description: "Conservative trader: only the tokens it was seen trading, through the exchange.",
  };
  const active: MandateDraft = {
    ...common,
    assets: everyToken,
    maxTradeUsd: activeCap,
    maxDailyUsd: activeCap * 10,
    maxDrawdownPct: 20,
    maxSlippagePct: 3,
    description:
      "Active trader: every market token, through the exchange, with room to trade more.",
  };
  const symbolOf = (address: string) =>
    Object.entries(market.tokens).find(([, a]) => a.toLowerCase() === address.toLowerCase())?.[0] ??
    address;
  const preset = (
    id: MandatePreset,
    label: string,
    line: string,
    rules: MandateDraft,
  ): SuggestedPreset => ({
    id,
    label,
    line,
    mode: "enforce",
    tokens: (rules.assets ?? []).map(symbolOf),
    maxTxUsd: rules.maxTradeUsd,
    maxDailyUsd: rules.maxDailyUsd,
    rules,
  });
  const notes: string[] = [];
  if (trading.trades === 0)
    notes.push(
      `No trade was seen, so the per-trade cap starts at $${DEFAULT_TRADE_CAP_USD.toLocaleString("en-US")} (the Arena demo mandate's cap); set it to what your agent really trades.`,
    );
  if (trading.transfers > 0)
    notes.push(
      "Your agent sent tokens in its episodes. Add the addresses it may pay (your own) as destinations; none are allowed by default.",
    );
  if (trading.approvals > 0)
    notes.push(
      "Your agent approved spenders in its episodes. Approvals to anything but the vault's own flow are breaches; trades through the exchange don't need them.",
    );
  if (trading.trades > 0 && !trading.usedRouter)
    notes.push("Your agent didn't use the exchange's swap function; check the allowed contracts.");
  return {
    basis: {
      sources: input.sources,
      trades: trading.trades,
      tokens: trading.tokens,
      largestTradeUsd: Math.round(largest * 100) / 100,
      usedRouter: trading.usedRouter,
      transfers: trading.transfers,
      approvals: trading.approvals,
    },
    tokens: trading.tokens.filter(
      (t) => symbolAddress(t)?.toLowerCase() !== market.usdg.toLowerCase(),
    ),
    contracts: trading.usedRouter ? [{ address: market.router, label: "Exchange (swap)" }] : [],
    largestTradeUsd: largest > 0 ? Math.round(largest * 100) / 100 : null,
    notes,
    recommended: "conservative",
    presets: [
      preset(
        "conservative",
        "Conservative trader",
        `Enforce mode; per-trade cap ${PRESET_HEADROOM.conservative}x the largest trade seen; only the tokens it traded.`,
        conservative,
      ),
      preset(
        "active",
        "Active trader",
        `Enforce mode; per-trade cap ${PRESET_HEADROOM.active}x the largest trade seen; every market token.`,
        active,
      ),
    ],
  };
}
