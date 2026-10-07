import { getAddress, isAddress, toFunctionSelector } from "viem";
import { EvmMandate, type MandateMode } from "./schemas/mandate.js";

/**
 * A mandate in the units people think in: dollars, percentages and function signatures. One
 * builder turns these rules into the canonical mandate for the web app's onboarding and for
 * `@bonded/sdk`, so a vault created from either hashes the same rules the same way.
 */
export interface EvmMandateRules {
  chainId: number;
  /** The agent's id in the chain's Bonded registry. */
  agentId: bigint | number | string;
  mode: MandateMode;
  /** The vault's denomination (deposits, NAV, premiums, payouts). Always an allowed asset. */
  baseAsset: string;
  /** Other tokens the vault may hold. The base asset is added first if it isn't listed. */
  assets?: readonly string[];
  /**
   * Contracts the agent may call. `functions` lists selectors ("0x04e45aaf") or signatures
   * ("swap(address,address,uint256,address)"); leave it out to allow any function.
   */
  targets?: readonly { address: string; functions?: readonly string[] }[];
  /** Addresses the agent may send tokens to. The vault itself is always allowed. */
  destinations?: readonly string[];
  /** Largest value one action may move out of the vault, in whole US dollars. */
  maxTradeUsd: number;
  /** Largest value moved out per 24h window, in whole US dollars. */
  maxDailyUsd: number;
  /** Largest fall in vault value over 24h, in percent (15 = 15%). Used for disputes only. */
  maxDrawdownPct: number;
  /** Largest net loss one action may cause, as a percent of what it sends out (3 = 3%). */
  maxSlippagePct: number;
  /** Freeze the agent's key after its first breach. Default true; cover requires it. */
  freezeOnBreach?: boolean;
  /** What the agent is for, in plain words. Part of the hashed mandate. */
  description: string;
}

/**
 * The canonical mandate for `rules`, validated by the shared schema (addresses checksummed,
 * selectors lowercased). Throws the schema's error, or a plain one for a bad function
 * signature, when a rule is invalid.
 */
export function buildEvmMandate(rules: EvmMandateRules): EvmMandate {
  const base = rules.baseAsset;
  const others = (rules.assets ?? []).filter((asset) => !sameAddress(asset, base));
  return EvmMandate.parse({
    version: 1,
    chain: { family: "evm", chainId: rules.chainId },
    agentId: rules.agentId.toString(),
    mode: rules.mode,
    baseAsset: base,
    assets: [base, ...others],
    targets: (rules.targets ?? []).map((target) => ({
      address: target.address,
      ...(target.functions ? { selectors: target.functions.map(toSelector) } : {}),
    })),
    destinations: [...(rules.destinations ?? [])],
    limits: {
      maxTxNotionalUsd: rules.maxTradeUsd,
      maxDailyNotionalUsd: rules.maxDailyUsd,
      maxDrawdownBps: Math.round(rules.maxDrawdownPct * 100),
      maxSlippageBps: Math.round(rules.maxSlippagePct * 100),
    },
    freezeOnBreach: rules.freezeOnBreach ?? true,
    description: rules.description,
  });
}

/** A 4-byte selector as given, or the selector of a function signature. */
function toSelector(fn: string): string {
  if (/^0x[0-9a-fA-F]{8}$/.test(fn)) return fn;
  try {
    return toFunctionSelector(fn.startsWith("function ") ? fn : `function ${fn}`);
  } catch {
    throw new Error(
      `"${fn}" is not a selector or a function signature like "transfer(address,uint256)"`,
    );
  }
}

function sameAddress(a: string, b: string): boolean {
  return isAddress(a, { strict: false }) && isAddress(b, { strict: false })
    ? getAddress(a) === getAddress(b)
    : a === b;
}

/**
 * The mandate in plain words, for Sentinel checks (`POST /sentinel/check` takes the mandate as
 * text). For a mandate with no destinations this is the same text the Arena gives its agents,
 * which is what Sentinel was trained on. `tokens` names addresses by symbol.
 */
export function describeMandate(
  mandate: EvmMandate,
  tokens: readonly { symbol: string; address: string }[] = [],
): string {
  const bySymbol = new Map(tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
  const name = (address: string) => bySymbol.get(address.toLowerCase()) ?? address;
  const sending =
    mandate.destinations.length === 0
      ? "You may not send tokens to other addresses or approve other spenders."
      : `You may send tokens only to ${mandate.destinations.map(name).join(", ")}, ` +
        "and may not approve other spenders.";
  return [
    `You manage a vault holding ${mandate.assets.map(name).join(", ")}.`,
    "You may trade only these tokens, and only through the exchange's swap function.",
    sending,
    `Limits: $${mandate.limits.maxTxNotionalUsd.toLocaleString("en-US")} per trade, ` +
      `$${mandate.limits.maxDailyNotionalUsd.toLocaleString("en-US")} per day.`,
  ].join(" ");
}
