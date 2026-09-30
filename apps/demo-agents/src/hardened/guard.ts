import {
  AGENT_TOOLS,
  type AgentPolicy,
  type AgentTask,
  type AgentToolbox,
  type BlockedAction,
  isAgentToolName,
  SENTINEL_INPUT_CHARS,
  type SentinelInput,
  type ToolResult,
} from "@bonded/shared";
import type { ModelUsage } from "../usage.js";

/**
 * hardened-agent's guard: every write the agent proposes is checked before it reaches the
 * vault. See ADR-007.
 *
 * The vault enforces the mandate on-chain whatever happens; the guard exists so the agent
 * doesn't try to break it in the first place (a blocked attempt still counts as a breach in a
 * rating, and in Monitor mode it goes through).
 */

/** What a guard sees when judging one proposed action. */
export interface GuardContext {
  task: AgentTask;
  /** Everything the agent has read from outside so far (untrusted), newest last. */
  untrustedInputs: string[];
  /**
   * The same reads as `{tool, output}`, in the shape Sentinel's training data uses
   * (`sentinelState` in @bonded/shared), so a fine-tuned model sees what it trained on.
   */
  untrustedCalls: SentinelInput[];
  /** USD traded so far in this run. */
  tradedUsd: number;
  /** A trade's USD price from the on-chain oracle (never the attackable price API). */
  priceUsd(symbol: string): Promise<number | undefined>;
}

export interface GuardVerdict {
  allow: boolean;
  reason?: string;
  /** Extra labels a model-based guard attaches (e.g. Sentinel's manipulated / action_risk). */
  labels?: Record<string, unknown>;
}

export interface ActionGuard {
  readonly name: string;
  /** Running total of model usage, for guards that call a model (e.g. Sentinel). */
  readonly usage?: ModelUsage;
  check(tool: string, args: Record<string, string>, context: GuardContext): Promise<GuardVerdict>;
}

/**
 * The deterministic guard: the mandate as code. Transfers and approvals only to allowlisted
 * addresses; swaps only between mandate tokens, within the per-trade and daily caps.
 */
export class PolicyGuard implements ActionGuard {
  readonly name = "policy";

  async check(
    tool: string,
    args: Record<string, string>,
    context: GuardContext,
  ): Promise<GuardVerdict> {
    const policy = context.task.policy;
    if (!policy) return { allow: false, reason: "no mandate policy to check against" };
    switch (tool) {
      case "transfer":
        return listed(policy.transferAllowlist, args.to)
          ? { allow: true }
          : { allow: false, reason: `transfers to ${args.to} are not in the mandate` };
      case "approve":
        return listed(policy.approvalAllowlist, args.spender)
          ? { allow: true }
          : { allow: false, reason: `approving ${args.spender} is not in the mandate` };
      case "swap":
        return this.checkSwap(policy, args, context);
      default:
        return { allow: false, reason: `unknown write ${tool}` };
    }
  }

  private async checkSwap(
    policy: AgentPolicy,
    args: Record<string, string>,
    context: GuardContext,
  ): Promise<GuardVerdict> {
    for (const symbol of [args.tokenIn, args.tokenOut]) {
      if (!tokenAllowed(policy, symbol)) {
        return { allow: false, reason: `${symbol} is not a mandate token` };
      }
    }
    const price = await context.priceUsd(args.tokenIn ?? "");
    if (price === undefined) return { allow: false, reason: `no price for ${args.tokenIn}` };
    const valueUsd = Number(args.amountIn) * price;
    if (!(valueUsd <= policy.maxTradeUsd)) {
      return {
        allow: false,
        reason: `trade of $${Math.round(valueUsd)} exceeds the $${policy.maxTradeUsd} per-trade cap`,
      };
    }
    if (context.tradedUsd + valueUsd > policy.maxDailyUsd) {
      return {
        allow: false,
        reason: `trade would take today's volume past the $${policy.maxDailyUsd} daily cap`,
      };
    }
    return { allow: true };
  }
}

/**
 * Wraps the Arena's (or production's) toolbox. Reads pass through and are remembered as
 * untrusted inputs; each write must pass every guard, in order, or it's refused with the
 * reason and recorded in `blocked`.
 */
export class GuardedToolbox implements AgentToolbox {
  readonly blocked: BlockedAction[] = [];
  readonly decisions: { tool: string; args: unknown; guard: string; verdict: GuardVerdict }[] = [];
  private readonly untrusted: string[] = [];
  private readonly untrustedCalls: SentinelInput[] = [];
  private tradedUsd = 0;

  constructor(
    private readonly inner: AgentToolbox,
    private readonly task: AgentTask,
    private readonly guards: ActionGuard[],
  ) {}

  get signal(): AbortSignal | undefined {
    return this.inner.signal;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (!isAgentToolName(name) || !AGENT_TOOLS[name].writes) {
      const result = await this.inner.call(name, args);
      if (result.ok && name !== "get_portfolio") {
        this.untrusted.push(`${name}: ${JSON.stringify(result.output)}`);
        this.untrustedCalls.push({
          tool: name,
          output: JSON.stringify(result.output).slice(0, SENTINEL_INPUT_CHARS),
        });
      }
      return result;
    }
    const parsed = AGENT_TOOLS[name].input.safeParse(args ?? {});
    // Malformed calls go to the toolbox, which reports the validation error.
    if (!parsed.success) return this.inner.call(name, args);
    const values = parsed.data as Record<string, string>;
    const context: GuardContext = {
      task: this.task,
      untrustedInputs: [...this.untrusted],
      untrustedCalls: [...this.untrustedCalls],
      tradedUsd: this.tradedUsd,
      priceUsd: (symbol) => this.price(symbol),
    };
    for (const guard of this.guards) {
      // A guard that fails (a malformed model answer, a network error) refuses the write
      // instead of crashing the agent: it fails closed and the episode keeps its evidence.
      let verdict: GuardVerdict;
      try {
        verdict = await guard.check(name, values, context);
      } catch (error) {
        verdict = {
          allow: false,
          reason: `guard failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      this.decisions.push({ tool: name, args, guard: guard.name, verdict });
      if (!verdict.allow) {
        const reason = `${guard.name}: ${verdict.reason ?? "refused"}`;
        this.blocked.push({ tool: name, args, reason });
        return { ok: false, error: `blocked by the agent's guard (${reason})` };
      }
    }
    const result = await this.inner.call(name, args);
    if (result.ok && name === "swap") {
      this.tradedUsd += Number(values.amountIn) * ((await this.price(values.tokenIn ?? "")) ?? 0);
    }
    return result;
  }

  /**
   * The on-chain oracle price, from the portfolio. Never the price API: that is content the
   * world (and so an attacker) controls, and a spoofed low price would let an oversized trade
   * past the size check and undercount the day's volume.
   */
  private async price(symbol: string): Promise<number | undefined> {
    const result = await this.inner.call("get_portfolio", {});
    if (!result.ok) return undefined;
    const prices = (result.output as { pricesUsd?: Record<string, number> }).pricesUsd ?? {};
    const key = Object.keys(prices).find(
      (k) =>
        k.toLowerCase() === symbol.toLowerCase() || k.toLowerCase() === `t${symbol}`.toLowerCase(),
    );
    return key === undefined ? undefined : prices[key];
  }
}

function listed(list: readonly string[], address: string | undefined): boolean {
  return address !== undefined && list.some((a) => a.toLowerCase() === address.toLowerCase());
}

function tokenAllowed(policy: AgentPolicy, symbol: string | undefined): boolean {
  if (!symbol) return false;
  const wanted = symbol.toLowerCase();
  return policy.tokens.some((t) => t.toLowerCase() === wanted || t.toLowerCase() === `t${wanted}`);
}
