import {
  AGENT_TOOLS,
  type AgentToolbox,
  type AgentToolName,
  demoRouterAbi,
  isAgentToolName,
  mandateVaultAbi,
  mockOracleAbi,
  testTokenAbi,
  type ToolResult,
} from "@bonded/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseUnits,
} from "viem";
import type { Sandbox } from "./sandbox.js";
import type { TokenListing, World } from "./world.js";

/** One tool call in an episode's trace. */
export interface TraceStep {
  step: number;
  tool: string;
  args: unknown;
  result: ToolResult;
  /** Transactions the call sent through the vault, in order. */
  txHashes: `0x${string}`[];
}

/**
 * The Arena's implementation of the agent tools. Reads come from the world simulator (where
 * attacks live) or the chain; every write is sent by the agent's key through its Mandate
 * Vault's `execute`, exactly as in production, so the vault sees and records what the agent
 * does. Every call is recorded in `trace`, and calls past `maxSteps` are refused.
 */
export class ArenaToolbox implements AgentToolbox {
  readonly trace: TraceStep[] = [];
  private closed = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly world: World,
    private readonly vault: `0x${string}`,
    private readonly maxSteps: number,
  ) {}

  /** Ends the episode: every later call is refused (e.g. an agent still running after a timeout). */
  close(): void {
    this.closed = true;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (this.closed) return { ok: false, error: "the episode is over" };
    const txHashes: `0x${string}`[] = [];
    const result = await this.dispatch(name, args, txHashes);
    this.trace.push({ step: this.trace.length + 1, tool: name, args, result, txHashes });
    return result;
  }

  private async dispatch(
    name: string,
    args: unknown,
    txHashes: `0x${string}`[],
  ): Promise<ToolResult> {
    if (this.trace.length >= this.maxSteps) {
      return { ok: false, error: `step limit of ${this.maxSteps} reached` };
    }
    if (!isAgentToolName(name)) return { ok: false, error: `unknown tool: ${name}` };
    const parsed = AGENT_TOOLS[name].input.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${parsed.error.issues[0]?.message}` };
    }
    try {
      return { ok: true, output: await this.run(name, parsed.data, txHashes) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  private async run(
    name: AgentToolName,
    args: Record<string, string>,
    txHashes: `0x${string}`[],
  ): Promise<unknown> {
    switch (name) {
      case "read_inbox":
        return this.world.inbox;
      case "read_news":
        return this.world.news;
      case "read_social":
        return this.world.social;
      case "get_market_report":
        return this.world.marketReport;
      case "get_recent_transfers":
        return this.world.transfers;
      case "get_token_info": {
        const token = this.world.findToken(args.symbol ?? "");
        if (!token) throw new Error(`no token listed as ${args.symbol}`);
        return token;
      }
      case "get_prices": {
        const prices: Record<string, number> = {};
        for (const token of this.world.tokenList) {
          prices[token.symbol] =
            this.world.priceOverrides.get(token.symbol) ?? (await this.oraclePrice(token));
        }
        return prices;
      }
      case "get_portfolio":
        return this.portfolio();
      case "swap": {
        const tokenIn = this.token(args.tokenIn);
        const tokenOut = this.token(args.tokenOut);
        const amountIn = parseUnits(args.amountIn ?? "0", tokenIn.decimals);
        const router = this.sandbox.deployment.router;
        const allowance = await this.sandbox.publicClient.readContract({
          address: tokenIn.address,
          abi: testTokenAbi,
          functionName: "allowance",
          args: [this.vault, router],
        });
        if (allowance < amountIn) {
          txHashes.push(
            await this.execute(tokenIn.address, "approve", [router, maxUint256], testTokenAbi),
          );
        }
        const before = await this.balance(tokenOut);
        txHashes.push(
          await this.execute(
            router,
            "swap",
            [tokenIn.address, tokenOut.address, amountIn, this.vault],
            demoRouterAbi,
          ),
        );
        const received = (await this.balance(tokenOut)) - before;
        return {
          sold: `${args.amountIn} ${tokenIn.symbol}`,
          received: `${formatUnits(received, tokenOut.decimals)} ${tokenOut.symbol}`,
        };
      }
      case "transfer": {
        const token = this.token(args.token);
        const amount = parseUnits(args.amount ?? "0", token.decimals);
        txHashes.push(
          await this.execute(token.address, "transfer", [args.to, amount], testTokenAbi),
        );
        return { sent: `${args.amount} ${token.symbol}`, to: args.to };
      }
      case "approve": {
        const token = this.token(args.token);
        const amount = parseUnits(args.amount ?? "0", token.decimals);
        txHashes.push(
          await this.execute(token.address, "approve", [args.spender, amount], testTokenAbi),
        );
        return { approved: `${args.amount} ${token.symbol}`, spender: args.spender };
      }
    }
  }

  /** Sends one action through the vault from the agent's key. */
  private async execute(
    target: `0x${string}`,
    functionName: string,
    args: readonly unknown[],
    abi: typeof testTokenAbi | typeof demoRouterAbi,
  ): Promise<`0x${string}`> {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<
      typeof encodeFunctionData
    >[0]);
    const agent = this.sandbox.wallet("agent");
    const { request } = await this.sandbox.publicClient.simulateContract({
      address: this.vault,
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [target, data],
      account: agent.account,
    });
    const hash = await agent.writeContract(request);
    const receipt = await this.sandbox.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction reverted (${hash})`);
    return hash;
  }

  private token(symbol: string | undefined): TokenListing {
    const token = this.world.findToken(symbol ?? "");
    if (!token) throw new Error(`no token listed as ${symbol}`);
    return token;
  }

  private balance(token: TokenListing): Promise<bigint> {
    return this.sandbox.publicClient.readContract({
      address: token.address,
      abi: testTokenAbi,
      functionName: "balanceOf",
      args: [this.vault],
    });
  }

  private async oraclePrice(token: TokenListing): Promise<number> {
    const usd6 = await this.sandbox.publicClient.readContract({
      address: this.sandbox.deployment.oracle,
      abi: mockOracleAbi,
      functionName: "valueInUsd6",
      args: [token.address, 10n ** BigInt(token.decimals)],
    });
    return Number(usd6) / 1e6;
  }

  private async portfolio() {
    const balances: Record<string, string> = {};
    let totalUsd = 0;
    for (const token of this.world.tokenList) {
      const raw = await this.balance(token);
      balances[token.symbol] = formatUnits(raw, token.decimals);
      totalUsd += Number(formatUnits(raw, token.decimals)) * (await this.oraclePrice(token));
    }
    return { vault: this.vault, balances, totalUsd: Math.round(totalUsd * 100) / 100 };
  }
}

/** A short, readable reason for a failed call (custom error name where there is one). */
function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      return `reverted: ${revert.data.errorName}`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
