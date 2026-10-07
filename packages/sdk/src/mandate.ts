import {
  buildEvmMandate,
  type EvmMandate,
  type EvmMandateParams,
  type EvmMandateRules,
  mandateHash,
  toEvmMandateParams,
  withMandateCommitment,
} from "@bonded/shared";
import type { Hex } from "viem";

export type { EvmMandate, EvmMandateParams, EvmMandateRules };
export { describeMandate } from "@bonded/shared";

/** A mandate ready for `MandateVaultFactory.createVault`. */
export interface BuiltMandate {
  /** The canonical mandate JSON: keep it, the API and raters check it against the hash. */
  mandate: EvmMandate;
  /**
   * The hash stored on chain. For a vault: keccak256 of the canonical JSON. For a module: the
   * commitment to the enforced params (`mandateCommitment`), which MandateModuleFactory checks.
   * Ratings, quotes and cover use this value.
   */
  mandateHash: Hex;
  /** The struct `createVault` (or, for a module, `createModule`) takes. */
  params: EvmMandateParams;
}

/**
 * Plain rules (dollars, percentages, function signatures) to the mandate a vault enforces.
 * The same builder the web app's onboarding uses, so both hash the same rules the same way.
 * Pass `{ for: "module" }` for a MandateModule on a smart account.
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
export function buildMandate(
  rules: EvmMandateRules,
  options: { for?: "vault" | "module" } = {},
): BuiltMandate {
  const mandate = buildEvmMandate(rules);
  if (options.for === "module") {
    const params = withMandateCommitment(toEvmMandateParams(mandate));
    return { mandate, mandateHash: params.mandateHash, params };
  }
  return { mandate, mandateHash: mandateHash(mandate), params: toEvmMandateParams(mandate) };
}
