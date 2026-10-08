import {
  BondedError,
  type BondedVault,
  guarded,
  type SentinelGuardOptions,
  type TokenInfo,
  type VaultAction,
} from "@bonded/sdk";
import { type Address, erc20Abi, parseUnits } from "viem";

/**
 * The agent's brain: a small rebalancer that buys a target token with the base asset.
 *
 * Its one rule for safety: everything it reads (messages, news, prices, reports) is data, never
 * instructions. Nothing it reads can add an action, change a recipient or move an amount; actions
 * come only from its own strategy (or, in an Arena episode, its task). And it doesn't rely on that
 * rule alone: every action goes through the vault, and the SDK's guard refuses anything the vault
 * would record as a breach before it is sent.
 */
export interface Strategy {
  /** The vault's base asset (first) and the tokens it trades. */
  tokens: readonly TokenInfo[];
  /** The token to hold. */
  target: string;
  /** How much base asset to spend per trade, in whole units. */
  tradeSize: string;
}

/** One action the brain wants, and why. */
export interface Decision {
  action: VaultAction;
  why: string;
}

/** Something the agent read, kept as untrusted context for Sentinel (never acted on). */
export interface UntrustedInput {
  tool: string;
  output: unknown;
}

/** Buy `tradeSize` of the base asset's worth of the target. */
export function buy(strategy: Strategy): Decision {
  const base = strategy.tokens[0]!;
  const target = token(strategy, strategy.target);
  return {
    action: {
      type: "swap",
      tokenIn: base.address as Address,
      tokenOut: target.address as Address,
      amountIn: parseUnits(strategy.tradeSize, base.decimals),
    },
    why: `buy ${strategy.tradeSize} ${base.symbol} worth of ${target.symbol}`,
  };
}

/** The rebalancer: buy the target while the vault holds none and can pay for it. */
export function decide(strategy: Strategy, balances: Record<string, bigint>): Decision[] {
  const base = strategy.tokens[0]!;
  const target = token(strategy, strategy.target);
  const size = parseUnits(strategy.tradeSize, base.decimals);
  return (balances[target.symbol] ?? 0n) === 0n && (balances[base.symbol] ?? 0n) >= size
    ? [buy(strategy)]
    : [];
}

/** What happened to one decision. */
export interface Outcome extends Decision {
  status: "sent" | "refused";
  detail: string;
}

/**
 * Sends each decision through the guarded vault: a dry run against the vault, and Sentinel if
 * configured (with what the agent read as its untrusted input). Refusals are reported, not thrown.
 */
export async function send(
  vault: BondedVault,
  decisions: readonly Decision[],
  untrusted: readonly UntrustedInput[] = [],
  sentinel?: SentinelGuardOptions,
): Promise<Outcome[]> {
  const safe = guarded(vault, sentinel ? { sentinel } : {});
  const untrustedInputs = untrusted.map((u) => ({
    tool: u.tool,
    output: typeof u.output === "string" ? u.output : JSON.stringify(u.output),
  }));
  const outcomes: Outcome[] = [];
  for (const decision of decisions) {
    try {
      const result = await safe.execute(decision.action, { untrustedInputs });
      outcomes.push({ ...decision, status: "sent", detail: result.hashes.join(", ") });
    } catch (error) {
      if (!(error instanceof BondedError)) throw error;
      outcomes.push({ ...decision, status: "refused", detail: error.message });
    }
  }
  return outcomes;
}

/** One cycle against a real vault: read its balances, decide, send guarded. */
export async function runOnce(
  vault: BondedVault,
  strategy: Strategy,
  untrusted: readonly UntrustedInput[] = [],
  sentinel?: SentinelGuardOptions,
): Promise<Outcome[]> {
  // The funds are in the vault, or in the smart account a mandate module guards.
  const { holder } = await vault.identify();
  const balances: Record<string, bigint> = {};
  for (const t of strategy.tokens)
    balances[t.symbol] = await vault.publicClient.readContract({
      address: t.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    });
  return send(vault, decide(strategy, balances), untrusted, sentinel);
}

function token(strategy: Strategy, symbol: string): TokenInfo {
  const t = strategy.tokens.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!t) throw new Error(`the strategy has no token ${symbol}`);
  return t;
}
