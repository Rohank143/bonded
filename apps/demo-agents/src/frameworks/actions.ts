// The same zod 3 package both frameworks resolve to: their checks use `instanceof`.
import { z } from "zod3";
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentToolbox,
  type AgentToolName,
} from "@bonded/shared";

/**
 * The Arena's tools as framework actions (docs/SPECIFICATION.md Section 8.4, "Framework adapters"). Each
 * adapter registers these with its framework's own action interface (AgentKit action provider,
 * Solana Agent Kit actions), so the framework's template agent runs unchanged and only the
 * execution lands in the Arena's sandbox. The schemas are built with zod 3 (as `zod3`), the
 * version both frameworks build their tool definitions with.
 */

const Amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
  .describe("Token amount in whole units as a decimal string, e.g. 2000 or 0.5");
const TokenSymbol = z.string().min(1).max(32).describe("Token symbol, e.g. tUSDG or tNVDA");
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("A 0x address");
const NoArgs = z.object({});

export interface ArenaAction {
  name: AgentToolName;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
}

/** Arguments for each Arena tool, mirroring AGENT_TOOLS in @bonded/shared (tested). */
const SCHEMAS: Record<AgentToolName, z.ZodObject<z.ZodRawShape>> = {
  read_inbox: NoArgs,
  read_news: NoArgs,
  read_social: NoArgs,
  get_prices: NoArgs,
  get_token_info: z.object({ symbol: TokenSymbol }),
  get_portfolio: NoArgs,
  get_recent_transfers: NoArgs,
  get_market_report: NoArgs,
  read_market_alerts: NoArgs,
  read_counterparty_messages: NoArgs,
  swap: z.object({ tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: Amount }),
  transfer: z.object({ token: TokenSymbol, to: Address, amount: Amount }),
  approve: z.object({ token: TokenSymbol, spender: Address, amount: Amount }),
};

/** Every Arena tool, with the shared descriptions. */
export const ARENA_ACTIONS: ArenaAction[] = AGENT_TOOL_NAMES.map((name) => ({
  name,
  description: AGENT_TOOLS[name].description,
  schema: SCHEMAS[name],
}));

/**
 * Runs actions against the Arena's toolbox and keeps the episode's step cap: past it, an action
 * returns an error instead of running. Results go back to the framework as text, the way its
 * own actions return them.
 */
export class ArenaBridge {
  steps = 0;
  constructor(
    private readonly tools: AgentToolbox,
    private readonly maxSteps: number,
  ) {}

  async call(name: AgentToolName, args: unknown): Promise<string> {
    if (this.steps >= this.maxSteps) return "Error: the step limit for this session is reached.";
    this.steps++;
    const result = await this.tools.call(name, args ?? {});
    return result.ok ? JSON.stringify(result.output) : `Error: ${result.error}`;
  }
}
