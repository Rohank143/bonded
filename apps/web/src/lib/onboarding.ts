import { EvmMandate, demoRouterAbi, type EvmDeployment, type SelfServeKind } from "@bonded/shared";
import { getAbiItem, toFunctionSelector } from "viem";

/** Mandate tokens a self-serve vault can hold; tUSDG is the base asset and always included. */
export const MANDATE_TOKENS = ["tTSLA", "tAMZN", "tNVDA"] as const;
export type MandateToken = (typeof MANDATE_TOKENS)[number];

export interface MandateForm {
  mode: "monitor" | "enforce";
  tokens: MandateToken[];
  /** Addresses the agent may send funds to, e.g. the depositor for refunds. */
  destinations: string[];
  maxTxUsd: number;
  maxDailyUsd: number;
  maxDrawdownPct: number;
  maxSlippagePct: number;
  description: string;
}

/**
 * The full mandate for a new self-serve vault. Its hash goes on chain at vault creation, and the
 * same JSON is sent when registering for ratings, so it must be built exactly once.
 */
export function buildMandate(
  deployment: EvmDeployment,
  agentId: bigint,
  form: MandateForm,
): EvmMandate {
  const address: Record<MandateToken, string> = {
    tTSLA: deployment.tsla,
    tAMZN: deployment.amzn,
    tNVDA: deployment.nvda,
  };
  return EvmMandate.parse({
    version: 1,
    chain: { family: "evm", chainId: deployment.chainId },
    agentId: agentId.toString(),
    mode: form.mode,
    baseAsset: deployment.usdg,
    assets: [deployment.usdg, ...form.tokens.map((t) => address[t])],
    targets: [
      {
        address: deployment.router,
        selectors: [toFunctionSelector(getAbiItem({ abi: demoRouterAbi, name: "swap" }))],
      },
    ],
    destinations: form.destinations,
    limits: {
      maxTxNotionalUsd: form.maxTxUsd,
      maxDailyNotionalUsd: form.maxDailyUsd,
      maxDrawdownBps: Math.round(form.maxDrawdownPct * 100),
      maxSlippageBps: Math.round(form.maxSlippagePct * 100),
    },
    // Cover requires it (CoverManager refuses a vault that doesn't freeze on breach).
    freezeOnBreach: true,
    description: form.description,
  });
}

/** What the onboarding page remembers about an agent it created, in this browser. */
export interface OnboardedAgent {
  vault: string;
  kind: SelfServeKind;
  mandate: EvmMandate;
}

const key = (chainId: number, agentId: string) => `bonded:onboarded:${chainId}:${agentId}`;

/** Saved so a failed registration for ratings can be retried from the agent's page. */
export function rememberAgent(chainId: number, agentId: string, agent: OnboardedAgent): void {
  try {
    localStorage.setItem(key(chainId, agentId), JSON.stringify(agent));
  } catch {
    // Storage can be unavailable (private windows); registration then needs a fresh onboarding.
  }
}

export function recallAgent(chainId: number, agentId: string): OnboardedAgent | undefined {
  try {
    const raw = localStorage.getItem(key(chainId, agentId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as OnboardedAgent;
    return { ...value, mandate: EvmMandate.parse(value.mandate) };
  } catch {
    return undefined;
  }
}
