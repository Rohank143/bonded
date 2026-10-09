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
        const [tokenIn, tokenOut, amountIn] = call.args as unknown as readonly [
          string,
          string,
          bigint,
        ];
        return {
          tool: "swap",
          args: {
            tokenIn: show(symbolOf(tokenIn)),
            tokenOut: show(symbolOf(tokenOut)),
            amountIn: show(formatUnits(amountIn, decimalsOf(tokenIn))),
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
    const action = stepAction(step, market);
    let outflowUsd = 0;
    let gasUsed = 0n;
    let target: ObservedTrade["target"] = "other";
    for (const hash of step.txHashes) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) continue;
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
