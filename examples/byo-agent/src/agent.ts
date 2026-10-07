import {
  BondedError,
  type BondedVault,
  guarded,
  type SentinelGuardOptions,
  type TokenInfo,
  type VaultAction,
} from "@bonded/sdk";
import { type Address, erc20Abi, getAddress, parseUnits } from "viem";

/**
 * The agent's brain: a small rebalancer that buys a target token with the base asset. It is
 * naive on purpose: it also does what messages in its inbox tell it to, like an LLM agent that
 * reads untrusted content. Protection doesn't depend on the brain being smart: every action
 * goes through the vault, and the SDK's guard refuses what the vault would record as a breach.
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

const INSTRUCTION = /send\s+([\d.]+)\s+(\w+)\s+to\s+(0x[0-9a-fA-F]{40})/i;

/** What to do, given the vault's balances (by symbol, base units) and the inbox. */
export function decide(
  strategy: Strategy,
  balances: Record<string, bigint>,
  inbox: readonly string[],
): Decision[] {
  const base = strategy.tokens[0]!;
  const target = token(strategy, strategy.target);
  const decisions: Decision[] = [];
  const size = parseUnits(strategy.tradeSize, base.decimals);
  if ((balances[target.symbol] ?? 0n) === 0n && (balances[base.symbol] ?? 0n) >= size)
    decisions.push({
      action: {
        type: "swap",
        tokenIn: base.address as Address,
        tokenOut: target.address as Address,
        amountIn: size,
      },
      why: `hold some ${target.symbol}`,
    });
  for (const message of inbox) {
    const match = INSTRUCTION.exec(message);
    if (!match) continue;
    const [, amount, symbol, to] = match;
    const t = token(strategy, symbol!);
    decisions.push({
      action: {
        type: "transfer",
        token: t.address as Address,
        to: getAddress(to!),
        amount: parseUnits(amount!, t.decimals),
      },
      why: `the inbox said: "${message}"`,
    });
  }
  return decisions;
}

/** What happened to one decision. */
export interface Outcome extends Decision {
  status: "sent" | "refused";
  detail: string;
}

/**
 * One cycle: read the vault's balances, decide, and send each action through the guarded vault
 * (a dry run against the vault, and Sentinel if configured). Refusals are reported, not thrown.
 */
export async function runOnce(
  vault: BondedVault,
  strategy: Strategy,
  inbox: readonly string[],
  sentinel?: SentinelGuardOptions,
): Promise<Outcome[]> {
  const balances: Record<string, bigint> = {};
  for (const t of strategy.tokens)
    balances[t.symbol] = await vault.publicClient.readContract({
      address: t.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault.address],
    });
  const safe = guarded(vault, sentinel ? { sentinel } : {});
  const untrustedInputs = inbox.map((output) => ({ tool: "read_inbox", output }));
  const outcomes: Outcome[] = [];
  for (const decision of decide(strategy, balances, inbox)) {
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

function token(strategy: Strategy, symbol: string): TokenInfo {
  const t = strategy.tokens.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase());
  if (!t) throw new Error(`the strategy has no token ${symbol}`);
  return t;
}
