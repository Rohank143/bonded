import { formatEther, numberToHex, type Chain } from "viem";
import type { OnboardingStep } from "./onboarding";

/**
 * Wallet help for onboarding (launch items 3.1 and 3.2): adding the network in one click, how much
 * test ETH the onboarding needs for gas, and fewer wallet confirmations by batching the
 * transactions (EIP-5792) when the wallet can do it atomically.
 */

/** The `wallet_addEthereumChain` parameters (EIP-3085) for a chain, from the shared config. */
export function addChainParams(chain: Chain) {
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    ...(chain.blockExplorers?.default
      ? { blockExplorerUrls: [chain.blockExplorers.default.url] }
      : {}),
  };
}

/**
 * Whether the wallet can send a batch of calls atomically on this chain (EIP-5792
 * `wallet_getCapabilities`). Reads the current `atomic.status` and the older `atomicBatch`.
 */
export function supportsAtomicBatch(capabilities: unknown, chainId: number): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const all = capabilities as Record<string, unknown>;
  // Keyed by chain, or (asked for one chain) that chain's capabilities themselves.
  const forChain = (all[chainId] ??
    all[numberToHex(chainId)] ??
    ("atomic" in all || "atomicBatch" in all ? all : undefined)) as
    { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  if (!forChain) return false;
  const status = forChain.atomic?.status;
  return status === "supported" || status === "ready" || forChain.atomicBatch?.supported === true;
}

/** One transaction of the onboarding. `findModule` is a read, not a transaction. */
export type OnboardingCall =
  | "register"
  | "faucet"
  | "approveBond"
  | "stake"
  | "createVault"
  | "findModule"
  | "approveDeposit"
  | "deposit";

/** Which onboarding step each call belongs to: a step is done when all its calls are. */
export const CALL_STEP: Record<OnboardingCall, OnboardingStep> = {
  register: "register",
  faucet: "faucet",
  approveBond: "bond",
  stake: "bond",
  createVault: "vault",
  findModule: "vault",
  approveDeposit: "deposit",
  deposit: "deposit",
};

/**
 * The onboarding's transactions, in groups that can each be sent as one batch. A group can only
 * use what earlier groups made: the agent id comes out of `register`, the vault's address out
 * of `createVault`, so those can't share a batch with what needs them. (Predicting either would
 * let a race on the shared chain send a bond or a deposit to someone else's agent or vault.)
 */
export function onboardingPlan(input: {
  done: readonly OnboardingStep[];
  bond: bigint;
  deposit: bigint;
  module: boolean;
}): OnboardingCall[][] {
  const todo = (s: OnboardingStep) => !input.done.includes(s);
  const deposit = input.module ? 0n : input.deposit;
  const needed = (todo("bond") ? input.bond : 0n) + deposit;
  const stakes = todo("bond") && input.bond > 0n;
  const first: OnboardingCall[] = [
    ...(todo("register") ? (["register"] as const) : []),
    ...(todo("faucet") && needed > 0n ? (["faucet"] as const) : []),
    ...(stakes ? (["approveBond"] as const) : []),
  ];
  const second: OnboardingCall[] = [
    ...(todo("vault") ? [input.module ? ("findModule" as const) : ("createVault" as const)] : []),
    ...(stakes ? (["stake"] as const) : []),
  ];
  const third: OnboardingCall[] =
    todo("deposit") && deposit > 0n ? ["approveDeposit", "deposit"] : [];
  return [first, second, third].filter((g) => g.length > 0);
}

const isTx = (c: OnboardingCall) => c !== "findModule";

/** How many times the wallet asks to confirm: one per batch, or one per transaction. */
export function confirmationCount(plan: OnboardingCall[][], batched: boolean): number {
  return plan.reduce((n, group) => {
    const txs = group.filter(isTx).length;
    return n + (batched ? (txs > 0 ? 1 : 0) : txs);
  }, 0);
}

/** "1 wallet confirmation", "7 wallet confirmations". */
export const confirmationsText = (n: number) => `${n} wallet confirmation${n === 1 ? "" : "s"}`;

/**
 * The test ETH the onboarding needs: the simulated gas of its transactions at the current gas
 * price, with a margin for the price moving before they are sent. Undefined without both.
 */
export function gasNeeded(input: {
  gasUsed: readonly bigint[] | undefined;
  gasPrice: bigint | undefined;
  /** Percent added on top. */
  marginPct?: number;
}): bigint | undefined {
  if (!input.gasUsed?.length || input.gasPrice === undefined) return undefined;
  const total = input.gasUsed.reduce((a, b) => a + b, 0n) * input.gasPrice;
  return (total * BigInt(100 + (input.marginPct ?? 50))) / 100n;
}

/** ETH for people: "0.00042 ETH", at most five significant digits after the point. */
export function ethText(wei: bigint): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  if (!frac) return `${whole} ETH`;
  const firstNonZero = frac.search(/[1-9]/);
  const keep = firstNonZero === -1 ? 0 : Math.min(frac.length, firstNonZero + 2);
  const shown = frac.slice(0, keep).replace(/0+$/, "");
  return shown ? `${whole}.${shown} ETH` : `${whole} ETH`;
}

/** The gas pre-check in a line, from what was measured. */
export function gasLine(
  needed: bigint | undefined,
  balance: bigint | undefined,
): {
  text: string;
  short: boolean;
} {
  if (needed === undefined)
    return {
      text: "You need a little test ETH for gas: the faucet gives enough for onboarding.",
      short: false,
    };
  if (balance === undefined)
    return { text: `You need about ${ethText(needed)} for gas.`, short: false };
  return balance >= needed
    ? {
        text: `You need about ${ethText(needed)} for gas, and you have ${ethText(balance)}.`,
        short: false,
      }
    : {
        text: `You need about ${ethText(needed)} for gas, but you have ${ethText(balance)}. Get test ETH from a faucet first.`,
        short: true,
      };
}
