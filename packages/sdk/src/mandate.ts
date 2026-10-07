import {
  buildEvmMandate,
  type EvmMandate,
  type EvmMandateParams,
  type EvmMandateRules,
  mandateHash,
  toEvmMandateParams,
} from "@bonded/shared";
import type { Hex } from "viem";

export type { EvmMandate, EvmMandateParams, EvmMandateRules };
export { describeMandate } from "@bonded/shared";

/** A mandate ready for `MandateVaultFactory.createVault`. */
export interface BuiltMandate {
  /** The canonical mandate JSON: keep it, the API and raters check it against the hash. */
  mandate: EvmMandate;
  /** keccak256 of the canonical JSON, stored in the vault. */
  mandateHash: Hex;
  /** The struct `createVault` takes. */
  params: EvmMandateParams;
}

/**
 * Plain rules (dollars, percentages, function signatures) to the mandate a vault enforces.
 * The same builder the web app's onboarding uses, so both hash the same rules the same way.
 *
 * ```ts
 * const { params, mandate } = buildMandate({
 *   chainId: 46630, agentId: 12n, mode: "enforce",
 *   baseAsset: usdg, assets: [tsla],
 *   targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
 *   maxTradeUsd: 5_000, maxDailyUsd: 25_000, maxDrawdownPct: 15, maxSlippagePct: 3,
 *   description: "Rebalance a tech basket against tUSDG.",
 * });
 * ```
 */
export function buildMandate(rules: EvmMandateRules): BuiltMandate {
  const mandate = buildEvmMandate(rules);
  return { mandate, mandateHash: mandateHash(mandate), params: toEvmMandateParams(mandate) };
}
