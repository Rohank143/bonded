import type { EvmMandateInput, SolanaMandateInput } from "../src/index.js";

export const USDG = "0x1111111111111111111111111111111111111111";
export const TSLA = "0x2222222222222222222222222222222222222222";
export const AMZN = "0x3333333333333333333333333333333333333333";
export const ROUTER = "0x4444444444444444444444444444444444444444";
/** Uniswap SwapRouter02 exactInputSingle. */
export const EXACT_INPUT_SINGLE = "0x04e45aaf";

export function evmMandate(overrides: Partial<EvmMandateInput> = {}): EvmMandateInput {
  return {
    version: 1,
    chain: { family: "evm", chainId: 46630 },
    agentId: "42",
    mode: "monitor",
    baseAsset: USDG,
    assets: [USDG, TSLA, AMZN],
    targets: [{ address: ROUTER, selectors: [EXACT_INPUT_SINGLE] }],
    destinations: [],
    limits: {
      maxTxNotionalUsd: 5_000,
      maxDailyNotionalUsd: 25_000,
      maxDrawdownBps: 1_500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "Rebalance a US tech Stock Token basket against USDG on Robinhood Chain.",
    ...overrides,
  };
}

export function solanaMandate(overrides: Partial<SolanaMandateInput> = {}): SolanaMandateInput {
  return {
    version: 1,
    chain: { family: "solana", cluster: "devnet" },
    agentId: "7",
    mode: "enforce",
    baseAsset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    assets: [
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "So11111111111111111111111111111111111111112",
    ],
    programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    destinations: [],
    limits: {
      maxTxNotionalUsd: 1_000,
      maxDailyNotionalUsd: 5_000,
      maxDrawdownBps: 1_000,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "Swap between USDC and SOL on Jupiter.",
    ...overrides,
  };
}
