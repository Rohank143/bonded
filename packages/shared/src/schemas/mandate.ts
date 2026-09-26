import { z } from "zod";
import { canonicalHash } from "../canonical.js";
import { evmAddress, isUnique, selector, solanaAddress, uintString } from "./common.js";

/**
 * A mandate is the machine-readable set of rules an agent must follow.
 * The full JSON lives off-chain; its hash and enforcement parameters live on-chain
 * in the agent's Mandate Vault. See docs/PLAN.md Section 6.1.
 */

/** monitor: the agent keeps full autonomy, breaches are recorded and the agent is frozen.
 *  enforce: breaches are blocked (the call reverts). */
export const MandateMode = z.enum(["monitor", "enforce"]);
export type MandateMode = z.infer<typeof MandateMode>;

/** Numeric codes used by the Solidity MandateVault. Order must match `BondedTypes.MandateMode`. */
export const MANDATE_MODE_CODE: Record<MandateMode, number> = { monitor: 0, enforce: 1 };

export const MandateLimits = z
  .object({
    /** Largest notional value of a single action, in whole US dollars. */
    maxTxNotionalUsd: z.number().int().positive(),
    /** Largest total notional value over a rolling 24h window, in whole US dollars. */
    maxDailyNotionalUsd: z.number().int().positive(),
    /** Largest allowed fall in vault value over 24h, in basis points (1500 = 15%). */
    maxDrawdownBps: z.number().int().min(1).max(10_000),
    /** Largest net loss one action may cause, as a share of its outflow, in basis points
     *  (300 = 3%). A bigger loss on an allowed call is a T3 breach (e.g. a honeypot swap). */
    maxSlippageBps: z.number().int().min(0).max(10_000),
  })
  .refine((limits) => limits.maxDailyNotionalUsd >= limits.maxTxNotionalUsd, {
    message: "maxDailyNotionalUsd must be at least maxTxNotionalUsd",
    path: ["maxDailyNotionalUsd"],
  });
export type MandateLimits = z.infer<typeof MandateLimits>;

const common = {
  version: z.literal(1),
  /** ERC-8004 agent id in the chain's Bonded registry, as a decimal string. */
  agentId: uintString,
  mode: MandateMode,
  limits: MandateLimits,
  /** Freeze the agent's session key after the first breach (recommended). */
  freezeOnBreach: z.boolean(),
  /** Plain-language summary of what the agent is meant to do. */
  description: z.string().min(1).max(1_000),
};

export const EvmTarget = z.object({
  address: evmAddress,
  /** Allowed function selectors. Omitted means any function on this contract. */
  selectors: z.array(selector).min(1).refine(isUnique, "duplicate selectors").optional(),
});
export type EvmTarget = z.infer<typeof EvmTarget>;

export const EvmMandate = z
  .object({
    ...common,
    chain: z.object({ family: z.literal("evm"), chainId: z.number().int().positive() }),
    /** Asset the vault is denominated in (deposits, NAV, premiums, payouts). */
    baseAsset: evmAddress,
    /** Tokens the vault may hold. Must include baseAsset. */
    assets: z.array(evmAddress).min(1).refine(isUnique, "duplicate assets"),
    /** Contracts (and optionally functions) the agent may call. */
    targets: z
      .array(EvmTarget)
      .refine((targets) => isUnique(targets.map((t) => t.address)), "duplicate targets"),
    /** Allowed recipients of outbound transfers. The vault itself is always allowed. */
    destinations: z.array(evmAddress).refine(isUnique, "duplicate destinations"),
  })
  .refine((mandate) => mandate.assets.some((asset) => asset === mandate.baseAsset), {
    message: "assets must include baseAsset",
    path: ["assets"],
  });
export type EvmMandate = z.infer<typeof EvmMandate>;
/** Unvalidated mandate as written by a user (addresses in any case). */
export type EvmMandateInput = z.input<typeof EvmMandate>;

export const SolanaMandate = z
  .object({
    ...common,
    chain: z.object({
      family: z.literal("solana"),
      cluster: z.enum(["localnet", "devnet", "testnet", "mainnet-beta"]),
    }),
    /** SPL mint the vault is denominated in. */
    baseAsset: solanaAddress,
    /** SPL mints the vault may hold. Must include baseAsset. */
    assets: z.array(solanaAddress).min(1).refine(isUnique, "duplicate assets"),
    /** Programs the agent may invoke through the vault. */
    programs: z.array(solanaAddress).refine(isUnique, "duplicate programs"),
    /** Allowed recipients (token account owners) of outbound transfers. The vault is always allowed. */
    destinations: z.array(solanaAddress).refine(isUnique, "duplicate destinations"),
  })
  .refine((mandate) => mandate.assets.includes(mandate.baseAsset), {
    message: "assets must include baseAsset",
    path: ["assets"],
  });
export type SolanaMandate = z.infer<typeof SolanaMandate>;
export type SolanaMandateInput = z.input<typeof SolanaMandate>;

export const Mandate = z.union([EvmMandate, SolanaMandate]);
export type Mandate = z.infer<typeof Mandate>;
export type MandateInput = z.input<typeof Mandate>;

/**
 * keccak256 of the canonical JSON of a *parsed* mandate. Parsing first normalises
 * addresses and selectors, so equivalent mandates always hash the same.
 */
export function mandateHash(mandate: MandateInput): `0x${string}` {
  return canonicalHash(Mandate.parse(mandate));
}

/** USD amounts on-chain use 6 decimals, matching USDC. */
export const USD_DECIMALS = 6;
const USD_UNIT = 10n ** BigInt(USD_DECIMALS);

/** Parameters passed to MandateVaultFactory.createVault (Solidity struct `MandateParams`). */
export interface EvmMandateParams {
  mandateHash: `0x${string}`;
  mode: number;
  baseAsset: `0x${string}`;
  assets: `0x${string}`[];
  targets: `0x${string}`[];
  /** selectors[i] lists the allowed selectors for targets[i]; empty means any function. */
  selectors: `0x${string}`[][];
  destinations: `0x${string}`[];
  maxTxNotionalUsd6: bigint;
  maxDailyNotionalUsd6: bigint;
  maxDrawdownBps: number;
  maxSlippageBps: number;
  freezeOnBreach: boolean;
}

export function toEvmMandateParams(input: EvmMandateInput): EvmMandateParams {
  const mandate = EvmMandate.parse(input);
  return {
    mandateHash: mandateHash(mandate),
    mode: MANDATE_MODE_CODE[mandate.mode],
    baseAsset: mandate.baseAsset,
    assets: mandate.assets,
    targets: mandate.targets.map((target) => target.address),
    selectors: mandate.targets.map((target) => target.selectors ?? []),
    destinations: mandate.destinations,
    maxTxNotionalUsd6: BigInt(mandate.limits.maxTxNotionalUsd) * USD_UNIT,
    maxDailyNotionalUsd6: BigInt(mandate.limits.maxDailyNotionalUsd) * USD_UNIT,
    maxDrawdownBps: mandate.limits.maxDrawdownBps,
    maxSlippageBps: mandate.limits.maxSlippageBps,
    freezeOnBreach: mandate.freezeOnBreach,
  };
}
