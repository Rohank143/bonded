import {
  demoRouterAbi,
  mandateVaultAbi,
  testTokenAbi,
  type TradingSummary,
} from "@bondedhq/shared";
import { decodeEventLog, decodeFunctionData, formatUnits, type Hex } from "viem";
import type { TraceStep } from "./toolbox.js";
import type { ArenaToken } from "./vault.js";

/**
 * What an agent's writes did, read from the trace and the vault's own `Executed` events: the
 * action (an `execute` a chain-mode agent signed is decoded into swap, transfer or approve), the
 * tokens, the contract it called, and the value the vault measured going out. This is what the
 * report's evidence shows and what a suggested mandate is built from.
 */

export interface ObservedTrade {
  step: number;
  /** Receipt-backed execution state; absent on legacy reports. */
  execution?: "confirmed" | "failed" | "unknown";
  /** Canonical operation/target/argument identity for executed financial actions. */
  actionKey?: string;
  /** Approval of the exchange needed to perform the actual trade. */
  bookkeeping?: boolean;
  tool: "swap" | "transfer" | "approve" | "other";
  /** The contract the vault called: the exchange, a token, or something else. */
  target: "router" | "token" | "other";
  /** Token symbols involved. */
  tokens: string[];
  /** Value out of the vault, in USD, as its `Executed` event measured it (0 when blocked). */
  outflowUsd: number;
  /** Gas the transaction used, when its receipt was read. */
  gasUsed?: string;
  /** The vault recorded a breach for this step. */
  breached: boolean;
}

/** The market the Arena's vaults trade: its tokens and the exchange. */
export interface ArenaMarket {
  tokens: readonly ArenaToken[];
  router: `0x${string}`;
}

/** Values that can be shown: an address, a number or a short symbol (never free text). */
const SHOWABLE = /^(0x[0-9a-fA-F]{40}|[0-9][0-9,]*(\.[0-9]+)?|all|[A-Za-z]{1,8})$/;
const show = (v: unknown) => (SHOWABLE.test(String(v)) ? String(v) : "(not shown)");

/**
 * A vault call (`execute(target, data)`) in the terms of the Arena's tools: swap, transfer or
 * approve with tokens by symbol and amounts in whole units; anything else as the target and its
 * function selector.
 */
export function decodeVaultCall(
  target: string,
  data: string,
  market: ArenaMarket,
): { tool: ObservedTrade["tool"]; args: Record<string, string>; tokens: string[] } {
  const token = market.tokens.find((t) => t.address.toLowerCase() === target.toLowerCase());
  const symbolOf = (address: string) =>
    market.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())?.symbol ?? address;
  const decimalsOf = (address: string) =>
    market.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())?.decimals ?? 18;
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (target.toLowerCase() === market.router.toLowerCase()) {
      const call = decodeFunctionData({ abi: demoRouterAbi, data: data as Hex });
      if (call.functionName === "swap") {
        const [tokenIn, tokenOut, amountIn, to] = call.args as unknown as readonly [
          string,
          string,
          bigint,
          string,
        ];
        return {
          tool: "swap",
          args: {
            tokenIn: show(symbolOf(tokenIn)),
            tokenOut: show(symbolOf(tokenOut)),
            amountIn: show(formatUnits(amountIn, decimalsOf(tokenIn))),
            to: show(to),
          },
          tokens: [symbolOf(tokenIn), symbolOf(tokenOut)],
        };
      }
    }
    if (token) {
      const call = decodeFunctionData({ abi: testTokenAbi, data: data as Hex });
      if (call.functionName === "transfer" || call.functionName === "approve") {
        const [who, amount] = call.args as readonly [string, bigint];
        return {
          tool: call.functionName,
          args: {
            token: token.symbol,
            amount: show(formatUnits(amount, token.decimals)),
            [call.functionName === "transfer" ? "to" : "spender"]: show(who),
          },
          tokens: [token.symbol],
        };
      }
    }
  } catch {
    // Not a call this knows: shown as its target and selector below.
  }
  return {
    tool: "other",
    args: { target: show(target), selector: /^0x[0-9a-f]{8}$/.test(selector) ? selector : "0x" },
    tokens: token ? [token.symbol] : [],
  };
}

/** The action a trace step took, decoded, with only showable arguments. */
export function stepAction(
  step: Pick<TraceStep, "tool" | "args">,
  market: ArenaMarket,
): { tool: string; args?: Record<string, string>; tokens: string[]; signed: boolean } {
  const args = (step.args ?? {}) as Record<string, unknown>;
  if (step.tool === "execute" && typeof args.target === "string" && typeof args.data === "string") {
    const decoded = decodeVaultCall(args.target, args.data, market);
    return {
      tool: decoded.tool === "other" ? "execute" : decoded.tool,
      args: decoded.args,
      tokens: decoded.tokens,
      signed: true,
    };
  }
  const keys: Record<string, string[]> = {
    swap: ["tokenIn", "tokenOut", "amountIn"],
    transfer: ["token", "amount", "to"],
    approve: ["token", "amount", "spender"],
  };
  const want = keys[step.tool];
  if (!want) return { tool: step.tool, tokens: [], signed: false };
  const out: Record<string, string> = {};
  for (const k of want) {
    const v = args[k];
    if (typeof v === "string" || typeof v === "number") out[k] = show(v);
  }
  const tokens = ["tokenIn", "tokenOut", "token"]
    .map((k) => args[k])
    .filter((v): v is string => typeof v === "string" && SHOWABLE.test(v));
  return { tool: step.tool, args: out, tokens, signed: false };
}

const WRITES = new Set(["swap", "transfer", "approve", "execute"]);

/** A minimal client: receipts are all this reads. */
export interface ReceiptReader {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    gasUsed: bigint;
    logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[];
  }>;
}

/**
 * Every write the agent made in an episode, with the value the vault measured, read from the
 * receipts of the step's transactions. A step whose receipt can't be read still counts, with no
 * outflow.
 */
export async function observeTrades(
  client: ReceiptReader,
  vault: `0x${string}`,
  trace: readonly TraceStep[],
  market: ArenaMarket,
): Promise<ObservedTrade[]> {
  const trades: ObservedTrade[] = [];
  for (const step of trace) {
    if (!WRITES.has(step.tool) || step.txHashes.length === 0) continue;
    const rawAction = stepAction(step, market);
    const args = rawAction.args ? { ...rawAction.args } : undefined;
    if (args) {
      for (const key of ["token", "tokenIn", "tokenOut"]) {
        if (args[key]) args[key] = resolveMarketToken(args[key], market)?.symbol ?? args[key]!;
      }
      if (rawAction.tool === "swap" && step.tool === "swap") args.to = vault;
    }
    const action = {
      ...rawAction,
      args,
      tokens: rawAction.tokens.map((token) => resolveMarketToken(token, market)?.symbol ?? token),
    };

    const expectedTarget =
      step.tool === "execute"
        ? String((step.args as Record<string, unknown>).target)
        : action.tool === "swap"
          ? market.router
          : market.tokens.find((t) => t.symbol.toLowerCase() === action.args?.token?.toLowerCase())
              ?.address;
    let outflowUsd = 0;
    let confirmed = false;
    let missingReceipt = false;
    let executedTarget: string | undefined;
    let gasUsed = 0n;
    let target: ObservedTrade["target"] = "other";
    for (const hash of step.txHashes) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) {
        missingReceipt = true;
        continue;
      }
      gasUsed += receipt.gasUsed;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
        try {
          const event = decodeEventLog({
            abi: mandateVaultAbi,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (event.eventName !== "Executed") continue;
          const a = event.args as { target: string; outflowUsd6: bigint };
          if (a.target.toLowerCase() === expectedTarget?.toLowerCase()) {
            confirmed = true;
            executedTarget = a.target;
          }
          outflowUsd += Number(a.outflowUsd6) / 1e6;
          target =
            a.target.toLowerCase() === market.router.toLowerCase()
              ? "router"
              : market.tokens.some((t) => t.address.toLowerCase() === a.target.toLowerCase())
                ? "token"
                : "other";
        } catch {
          // Another event of the vault.
        }
      }
    }
    // Approving the exchange is part of trading through it, not an approval to another spender.
    const routerApproval =
      action.tool === "approve" &&
      action.args?.spender?.toLowerCase() === market.router.toLowerCase();
    const tool = routerApproval
      ? undefined
      : (["swap", "transfer", "approve"] as const).find((t) => t === action.tool);
    trades.push({
      step: step.step,
      execution: missingReceipt ? "unknown" : confirmed ? "confirmed" : "failed",
      ...(routerApproval ? { bookkeeping: true } : {}),
      ...(confirmed && !missingReceipt && !routerApproval && executedTarget && action.args
        ? { actionKey: financialActionKey(action.tool, executedTarget, action.args, step) }
        : {}),
      tool: tool ?? "other",
      target,
      tokens: [...new Set(action.tokens)],
      outflowUsd,
      ...(gasUsed > 0n ? { gasUsed: gasUsed.toString() } : {}),
      breached: step.breaches.length > 0,
    });
  }
  return trades;
}

/** What an agent did without breaching, summed over episodes (`TradingSummary`). */
export function tradingSummary(trades: readonly ObservedTrade[]): TradingSummary {
  const clean = trades.filter((t) => !t.breached);
  const executed = clean.filter((t) => t.outflowUsd > 0 || t.target !== "other");
  return {
    trades: executed.length,
    tokens: [...new Set(executed.flatMap((t) => t.tokens))].sort(),
    usedRouter: executed.some((t) => t.target === "router"),
    transfers: executed.filter((t) => t.tool === "transfer").length,
    approvals: executed.filter((t) => t.tool === "approve").length,
    largestTradeUsd: Math.max(0, ...executed.map((t) => t.outflowUsd)),
    totalOutflowUsd: executed.reduce((n, t) => n + t.outflowUsd, 0),
  };
}

/** Compare decoded operations rather than counts or token unions. */
function financialActionKey(
  tool: string,
  target: string,
  args: Record<string, string>,
  step: TraceStep,
): string | undefined {
  if (Object.values(args).some((value) => value === "all" || value === "(not shown)"))
    return undefined;
  const normalize = (value: string) =>
    /^\d+(?:\.\d+)?$/.test(value)
      ? value
          .replace(/^0+(?=\d)/, "")
          .replace(/(\.\d*?)0+$/, "$1")
          .replace(/\.$/, "")
      : value.toLowerCase();
  // Unknown execute calls need their complete calldata, not only a shared function selector.
  const fields =
    tool === "execute" ? { data: String((step.args as Record<string, unknown>).data) } : args;
  return JSON.stringify([
    tool,
    target.toLowerCase(),
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, normalize(value)]),
  ]);
}

/** Undefined means incomplete or legacy evidence; it must not establish resistance. */
export function executedActions(
  trades: readonly ObservedTrade[] | undefined,
): string[] | undefined {
  if (
    !trades ||
    trades.some(
      (t) =>
        !t.execution ||
        t.execution === "unknown" ||
        (t.execution === "confirmed" && !t.bookkeeping && !t.actionKey),
    )
  )
    return undefined;
  return trades
    .filter((t) => t.execution === "confirmed" && !t.bookkeeping)
    .map((t) => t.actionKey!)
    .sort();
}

/** Match the toolbox/World's case-insensitive optional test-token prefix. */
function resolveMarketToken(symbol: string, market: ArenaMarket) {
  const wanted = symbol.toLowerCase();
  return (
    market.tokens.find((t) => t.symbol.toLowerCase() === wanted) ??
    market.tokens.find((t) => t.symbol.toLowerCase() === `t${wanted}`)
  );
}
