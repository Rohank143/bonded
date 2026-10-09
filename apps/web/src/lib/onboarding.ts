import { EvmMandate, demoRouterAbi, type EvmDeployment, type SelfServeKind } from "@bondedhq/shared";
import { getAbiItem, isAddress, toFunctionSelector } from "viem";
import { parseUsd } from "./format";

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

/**
 * A funding amount typed by the user, in 6-decimal units. Empty or "0" means an explicit zero
 * (skip that step); anything else that isn't a valid positive amount is null, never zero, so a
 * typo can't silently skip bonding or depositing.
 */
export function parseAmount(text: string): bigint | null {
  const t = text.trim();
  if (t === "" || /^0+(\.0+)?$/.test(t)) return 0n;
  return parseUsd(t);
}

export interface OnboardingInput {
  connected: boolean;
  form: MandateForm;
  agentKey: string;
  bond: string;
  deposit: string;
}

/**
 * Everything wrong with the form, checked before the first transaction: the mandate as the shared
 * schema will judge it (built with a placeholder agent id), the agent key and both funding
 * amounts. An empty list means onboarding can start.
 */
export function validateOnboarding(deployment: EvmDeployment, input: OnboardingInput): string[] {
  const problems: string[] = [];
  if (!input.connected) problems.push("Connect a wallet first.");
  if (!isAddress(input.agentKey)) problems.push("The agent key must be an address.");
  for (const d of input.form.destinations)
    if (!isAddress(d)) problems.push(`The refund address ${d} isn't an address.`);
  const { maxTxUsd, maxDailyUsd } = input.form;
  if (Number.isFinite(maxTxUsd) && Number.isFinite(maxDailyUsd) && maxDailyUsd < maxTxUsd)
    problems.push("The daily limit must be at least the per-trade limit.");
  try {
    buildMandate(deployment, 1n, input.form);
  } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    for (const issue of issues ?? [{ path: [], message: String(e) }]) {
      const field = String(issue.path.at(-1));
      const name = MANDATE_FIELD[field] ?? issue.path.join(".");
      problems.push(
        LIMIT_FIELDS.has(field)
          ? `${name} must be a positive whole number of dollars.`
          : field === "description"
            ? "Description must be 1 to 1,000 characters."
            : `${name}: ${issue.message}`,
      );
    }
  }
  if (parseAmount(input.bond) === null)
    problems.push("The bond must be a positive tUSDG amount with at most 6 decimals, or 0.");
  if (parseAmount(input.deposit) === null)
    problems.push("The deposit must be a positive tUSDG amount with at most 6 decimals, or 0.");
  return problems;
}

const LIMIT_FIELDS = new Set(["maxTxNotionalUsd", "maxDailyNotionalUsd"]);

/** Plain names for the mandate fields the schema can reject. */
const MANDATE_FIELD: Record<string, string> = {
  maxTxNotionalUsd: "Per-trade limit",
  maxDailyNotionalUsd: "Daily limit",
  maxDrawdownBps: "Maximum drawdown",
  maxSlippageBps: "Maximum slippage",
  description: "Description",
  destinations: "Refund address",
};

/** Onboarding steps, in order. */
export const ONBOARDING_STEPS = [
  "register",
  "vault",
  "faucet",
  "bond",
  "deposit",
  "ratings",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * An onboarding in progress, saved after each step so a rejected wallet prompt or a reload can
 * resume from the first unfinished step instead of registering another agent.
 */
export interface OnboardingProgress {
  kind: SelfServeKind;
  form: MandateForm;
  agentKey: string;
  bond: string;
  deposit: string;
  agentId?: string;
  mandate?: EvmMandate;
  vault?: string;
  done: OnboardingStep[];
}

const progressKey = (chainId: number, wallet: string) =>
  `bonded:onboarding:${chainId}:${wallet.toLowerCase()}`;

export function saveProgress(chainId: number, wallet: string, progress: OnboardingProgress | null) {
  try {
    if (progress) localStorage.setItem(progressKey(chainId, wallet), JSON.stringify(progress));
    else localStorage.removeItem(progressKey(chainId, wallet));
  } catch {
    // Without storage, an interrupted onboarding has to start again.
  }
}

export function loadProgress(chainId: number, wallet: string): OnboardingProgress | undefined {
  try {
    const raw = localStorage.getItem(progressKey(chainId, wallet));
    if (!raw) return undefined;
    const p = JSON.parse(raw) as OnboardingProgress;
    return p.mandate ? { ...p, mandate: EvmMandate.parse(p.mandate) } : p;
  } catch {
    return undefined;
  }
}

/** The first step still to do, or undefined when every step is done. */
export function nextStep(progress: OnboardingProgress): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find((s) => !progress.done.includes(s));
}
