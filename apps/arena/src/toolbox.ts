import {
  AGENT_TOOLS,
  type AgentToolbox,
  type AgentToolName,
  breachTypeFromCode,
  demoRouterAbi,
  isAgentToolName,
  mandateVaultAbi,
  mockOracleAbi,
  testTokenAbi,
  type ToolResult,
} from "@bondedhq/shared";
import {
  type Abi,
  encodeFunctionData,
  formatUnits,
  getAddress,
  maxUint256,
  parseUnits,
} from "viem";
import type { ChainHandle } from "./sandbox.js";
import { send } from "./vault.js";
import type { TokenListing, World } from "./world.js";

/** One tool call in an episode's trace. */
export interface TraceStep {
  step: number;
  tool: string;
  args: unknown;
  result: ToolResult;
  /** Transactions the call sent through the vault, in order. */
  txHashes: `0x${string}`[];
  /** Ids of the breaches the vault recorded during this call (see the verdict for details). */
  breaches: number[];
}

const PENDING: ToolResult = { ok: false, error: "pending" };

/**
 * The Arena's implementation of the agent tools. Reads come from the world simulator (where
 * attacks live) or the chain; every write is sent by the agent's key through its Mandate
 * Vault's `execute`, exactly as in production, so the vault sees and records what the agent
 * does.
 *
 * - Every call gets its trace step when it starts, so the step cap holds and steps stay in
 *   call order even when an agent makes calls in parallel.
 * - Writes run one at a time (parallel sends from one key would collide on nonces).
 * - `close()` ends the episode: it aborts `signal`, refuses new calls, and waits for calls
 *   already running, so the judge never reads the vault while a transaction is in flight.
 */
export class ArenaToolbox implements AgentToolbox {
  readonly trace: TraceStep[] = [];
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sandbox: ChainHandle,
    private readonly world: World,
    /** The episode's vault: every write goes through its `execute`. */
    readonly vault: `0x${string}`,
    readonly maxSteps: number,
  ) {}

  /** Aborted when the episode ends; agents should stop working when it fires. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  call(name: string, args: unknown): Promise<ToolResult> {
    return this.step(name, args, (entry) => this.dispatch(entry));
  }

  /**
   * Records a transaction the agent signed and sent itself, as a step named `execute`: in the
   * gateway's chain mode (gateway/rpc.ts) writes reach the vault that way instead of through a
   * write tool. It counts toward the step cap, runs one at a time with other writes, `close()`
   * waits for it, and the breaches it caused are read back, exactly as for a write tool.
   *
   * `send` submits the transaction and returns its hash; it isn't called once the step cap is
   * reached or the episode is over.
   */
  recordTransaction(args: unknown, send: () => Promise<`0x${string}`>): Promise<ToolResult> {
    return this.step("execute", args, async (entry) => {
      if (entry.step > this.maxSteps) {
        return { ok: false, error: `step limit of ${this.maxSteps} reached` };
      }
      try {
        const output = await this.serialise(async () => {
          const hash = await this.throughVault(entry, send);
          return { hash };
        });
        return { ok: true, output };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }

  /** Gives the call its trace step when it starts, and tracks it until it settles. */
  private step(
    name: string,
    args: unknown,
    run: (entry: TraceStep) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (this.abort.signal.aborted)
      return Promise.resolve({ ok: false, error: "the episode is over" });
    const entry: TraceStep = {
      step: this.trace.length + 1,
      tool: name,
      args,
      result: PENDING,
      txHashes: [],
      breaches: [],
    };
    this.trace.push(entry);
    const done = run(entry).then((result) => (entry.result = result));
    this.inFlight.add(done);
    void done.finally(() => this.inFlight.delete(done));
    return done;
  }

  private async dispatch(entry: TraceStep): Promise<ToolResult> {
    const { tool: name, args } = entry;
    if (entry.step > this.maxSteps) {
      return { ok: false, error: `step limit of ${this.maxSteps} reached` };
    }
    if (!isAgentToolName(name)) return { ok: false, error: `unknown tool: ${name}` };
    const parsed = AGENT_TOOLS[name].input.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${parsed.error.issues[0]?.message}` };
    }
    try {
      const run = () => this.run(name, parsed.data, entry);
      const output = AGENT_TOOLS[name].writes ? await this.serialise(run) : await run();
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }

  private async run(
    name: AgentToolName,
    args: Record<string, string>,
    entry: TraceStep,
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
      case "read_market_alerts":
        return this.world.marketAlerts;
      case "read_counterparty_messages":
        return this.world.counterpartyMessages;
      case "get_recent_transfers":
        return this.world.transfers;
      case "get_token_info":
        return this.token(args.symbol);
      case "get_prices":
        return this.prices();
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
          await this.execute(entry, tokenIn.address, testTokenAbi, "approve", [router, maxUint256]);
        }
        const before = await this.balance(tokenOut);
        await this.execute(entry, router, demoRouterAbi, "swap", [
          tokenIn.address,
          tokenOut.address,
          amountIn,
          this.vault,
        ]);
        const received = (await this.balance(tokenOut)) - before;
        return {
          sold: `${args.amountIn} ${tokenIn.symbol}`,
          received: `${formatUnits(received, tokenOut.decimals)} ${tokenOut.symbol}`,
        };
      }
      case "transfer": {
        const token = this.token(args.token);
        const amount = parseUnits(args.amount ?? "0", token.decimals);
        await this.execute(entry, token.address, testTokenAbi, "transfer", [
          address(args.to),
          amount,
        ]);
        return { sent: `${args.amount} ${token.symbol}`, to: args.to };
      }
      case "approve": {
        const token = this.token(args.token);
        const amount = parseUnits(args.amount ?? "0", token.decimals);
        await this.execute(entry, token.address, testTokenAbi, "approve", [
          address(args.spender),
          amount,
        ]);
        return { approved: `${args.amount} ${token.symbol}`, spender: args.spender };
      }
    }
  }

  /**
   * Sends one action through the vault from the agent's key. `MandateVault.execute` doesn't
   * revert when Enforce mode blocks an action, or when it freezes the agent over an earlier
   * unexplained outflow before acting; it returns empty and records a breach. So the breach
   * log is checked afterwards, and a blocked or skipped action fails the tool call instead of
   * being reported to the agent as done.
   */
  private async execute(
    entry: TraceStep,
    target: `0x${string}`,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<void> {
    const data = encodeFunctionData({ abi, functionName, args });
    await this.throughVault(entry, async () => {
      const { hash } = await send(this.sandbox, "agent", {
        address: this.vault,
        abi: mandateVaultAbi,
        functionName: "execute",
        args: [target, data],
      });
      return hash;
    });
  }

  /**
   * Sends one transaction to the vault and reads back the breaches it caused, failing the step
   * when the vault blocked or skipped the action (see `execute`) or the transaction reverted.
   */
  private async throughVault(
    entry: TraceStep,
    sendTx: () => Promise<`0x${string}`>,
  ): Promise<`0x${string}`> {
    const before = await this.breachCount();
    const hash = await sendTx();
    entry.txHashes.push(hash);
    const receipt = await this.sandbox.publicClient.waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    const after = await this.breachCount();
    for (let id = before; id < after; id++) entry.breaches.push(Number(id));
    if (receipt.status !== "success") throw new Error(`the transaction reverted (${hash})`);
    for (let id = before; id < after; id++) {
      const breach = await this.sandbox.publicClient.readContract({
        address: this.vault,
        abi: mandateVaultAbi,
        functionName: "getBreach",
        args: [id],
      });
      const type = breachTypeFromCode(breach.breachType);
      if (breach.blocked) throw new Error(`blocked by the vault (${type})`);
      if (type === "T1_DEFERRED") {
        throw new Error(
          "the vault froze the agent before acting (an earlier outflow was unexplained)",
        );
      }
    }
    return hash;
  }

  private breachCount(): Promise<bigint> {
    return this.sandbox.publicClient.readContract({
      address: this.vault,
      abi: mandateVaultAbi,
      functionName: "breachCount",
    });
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

  /**
   * Prices as the (possibly attacked) price API reports them: the oracle's, a few tenths of a
   * percent off as two real sources would be, unless an attack overrides them.
   */
  private async prices(): Promise<Record<string, number>> {
    const tokens = this.world.tokenList;
    const onChain = await Promise.all(tokens.map((token) => this.oraclePrice(token)));
    return Object.fromEntries(
      tokens.map((token, i) => [
        token.symbol,
        this.world.priceOverrides.get(token.symbol) ??
          Math.round((onChain[i] ?? 0) * (this.world.priceNoise.get(token.symbol) ?? 1) * 100) /
            100,
      ]),
    );
  }

  /**
   * Real balances valued at the real on-chain oracle price, with those prices. Unlike the price
   * API, nothing here comes from the world simulator, so an attack can't change it.
   */
  private async portfolio() {
    const tokens = this.world.tokenList;
    const [raw, prices] = await Promise.all([
      Promise.all(tokens.map((token) => this.balance(token))),
      Promise.all(tokens.map((token) => this.oraclePrice(token))),
    ]);
    const balances: Record<string, string> = {};
    const pricesUsd: Record<string, number> = {};
    let totalUsd = 0;
    tokens.forEach((token, i) => {
      const amount = formatUnits(raw[i] ?? 0n, token.decimals);
      balances[token.symbol] = amount;
      pricesUsd[token.symbol] = prices[i] ?? 0;
      totalUsd += Number(amount) * (prices[i] ?? 0);
    });
    return {
      vault: this.vault,
      balances,
      pricesUsd,
      totalUsd: Math.round(totalUsd * 100) / 100,
    };
  }
}

/** An address in any letter case (agents often get checksums wrong), checksummed. */
function address(text: string | undefined): `0x${string}` {
  return getAddress((text ?? "").toLowerCase());
}

/** A short, readable reason for a failed call (custom error name where there is one). */
function describeError(error: unknown): string {
  // Matched by name, not instanceof: the sandbox's clients come from @bonded/sandbox, whose copy
  // of viem can differ from this package's.
  if (error instanceof Error && error.name.endsWith("Error") && "shortMessage" in error) {
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      const errorName = (e as { data?: { errorName?: string } }).data?.errorName;
      if (e.name === "ContractFunctionRevertedError" && errorName) return `reverted: ${errorName}`;
    }
    return String(error.shortMessage);
  }
  return error instanceof Error ? error.message : String(error);
}
