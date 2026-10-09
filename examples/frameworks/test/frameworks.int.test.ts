import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ViemWalletProvider } from "@coinbase/agentkit";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { MockLanguageModelV4 } from "ai/test";
import { bondedPlugin, bondedEpisodePlugin, type ElizaRuntime } from "@bonded/sdk/eliza";
import { connectEpisodeTools, isBondedEpisode, mcpConfig } from "@bonded/sdk/mcp";
import { bondedLangChainTools } from "@bonded/sdk/langchain";
import { BondedVault } from "@bonded/sdk";
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKitFor } from "../src/agentkit.js";
import { runAiSdkEpisode } from "../src/ai-sdk.js";
import { runLangGraphAgent } from "../src/langgraph.js";
import { calls, envFor, startArena, TASK, type TestArena } from "./arena.js";

/**
 * Each framework helper end to end: a real Arena Gateway episode, an agent built the framework's
 * own way with a scripted model (no paid model calls), and the proof is on the Arena's side: the
 * tool calls are in the episode's trace, the swap went through the episode vault, and /done
 * arrived.
 */
let arena: TestArena;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // AgentKit posts analytics to Coinbase from its wallet providers and actions; keep tests local.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host === "cca-lite.coinbase.com") return new Response(null, { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  arena = await startArena();
}, 180_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await arena?.stop();
});

const SWAP = { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "300" };

describe("@bonded/sdk/mcp", () => {
  it("connects to the episode's MCP endpoint and calls its tools", async () => {
    const { episode, toolbox, gatewayEpisode } = await arena.episode();
    const tools = await connectEpisodeTools(episode);
    expect(tools.tools.map((t) => t.name)).toContain("swap");
    const swap = tools.tools.find((t) => t.name === "swap")!;
    expect(swap.inputSchema).toMatchObject({
      type: "object",
      required: ["tokenIn", "tokenOut", "amountIn"],
    });

    const prices = await tools.callTool("get_prices");
    expect(prices).toMatchObject({ ok: true });
    expect(JSON.parse(prices.text)).toEqual(prices.ok ? prices.output : undefined);
    const bad = await tools.callTool("get_token_info", { symbol: "" });
    expect(bad.ok).toBe(false);
    expect((await tools.listTools()).tools.length).toBe(tools.tools.length);

    await tools.done({ finalMessage: "finished", usage: { inputTokens: 10, outputTokens: 2 } });
    await expect(gatewayEpisode.done).resolves.toEqual({
      finalMessage: "finished",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(calls(toolbox)[0]).toBe("get_prices:ok");
    await tools.close();
  });

  it("reads the episode from the runner's BONDED_* variables", async () => {
    const { episode } = await arena.episode();
    const env = envFor(episode);
    expect(isBondedEpisode(env)).toBe(true);
    expect(isBondedEpisode({})).toBe(false);
    expect(mcpConfig(episode)).toEqual({
      mcpServers: { "bonded-episode": { type: "http", url: episode.endpoints.mcp } },
    });
    expect(mcpConfig(episode, { style: "stdio", name: "arena" }).mcpServers.arena).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote@0.14.3", episode.endpoints.mcp],
    });
    expect(mcpConfig(episode, { style: "url" }).mcpServers["bonded-episode"]).toEqual({
      url: episode.endpoints.mcp,
    });

    // The CLI prints the same block from the environment, for agents that read a config file.
    const cli = fileURLToPath(
      import.meta
        .resolve("@bonded/sdk/package.json")
        .replace("package.json", "dist/mcp-config-cli.js"),
    );
    const printed = spawnSync(process.execPath, [cli], {
      env: { ...env, PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual(mcpConfig(episode));
    const outside = spawnSync(process.execPath, [cli], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(outside.status).toBe(1);
    expect(outside.stderr).toMatch(/BONDED_EPISODE_ID/);
  });
});

/** A LangChain chat model that follows a script instead of calling a provider. */
class ScriptedChatModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  bound: unknown[] = [];
  private step = 0;
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted";
  }
  override bindTools(tools: unknown[]) {
    this.bound = tools;
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.script[this.step++] ?? new AIMessage("done");
    return {
      generations: [{ message, text: typeof message.content === "string" ? message.content : "" }],
    };
  }
}

const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

describe("@bonded/sdk/langchain", () => {
  it("a LangGraph ReAct agent reads and trades through the episode's tools", async () => {
    const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
    const llm = new ScriptedChatModel([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "get_prices", args: {} },
          { id: "c2", name: "read_inbox", args: {} },
        ],
        usage_metadata: usage,
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c3", name: "swap", args: SWAP }],
        usage_metadata: usage,
      }),
      new AIMessage({ content: "Bought 300 tUSDG of tNVDA.", usage_metadata: usage }),
    ]);
    const production = [
      new DynamicStructuredTool({
        name: "prod",
        description: "production",
        schema: { type: "object" as const, properties: {} },
        func: async () => "",
      }),
    ];
    const answer = await runLangGraphAgent({
      llm,
      tools: production,
      goal: TASK.goal,
      system: TASK.mandate,
      episode,
    });

    expect(answer).toBe("Bought 300 tUSDG of tNVDA.");
    // The model was given the episode's tools, not the production ones.
    expect((llm.bound as { name: string }[]).map((t) => t.name)).toContain("read_social");
    // It read the Arena's answers as tool messages.
    const toolMessages = llm.seen[1]!.filter((m) => m instanceof ToolMessage);
    expect(toolMessages).toHaveLength(2);
    expect(String(toolMessages[0]!.content)).toMatch(/tNVDA/);
    // The Arena saw the calls, and the swap went through the episode vault.
    expect(calls(toolbox)).toEqual(["get_prices:ok", "read_inbox:ok", "swap:ok"]);
    expect(toolbox.trace[2]!.txHashes.length).toBeGreaterThan(0);
    expect(await balance("tNVDA")).toBeGreaterThan(0n);
    await expect(gatewayEpisode.done).resolves.toEqual({
      finalMessage: "Bought 300 tUSDG of tNVDA.",
      usage: { inputTokens: 300, outputTokens: 60 },
    });
  });

  it("returns a failed call to the model as an error, as a production tool would", async () => {
    const { episode, toolbox } = await arena.episode();
    const tools = await bondedLangChainTools(episode);
    const info = tools.find((t) => t.name === "get_token_info")!;
    expect(await info.invoke({ symbol: "NOPE" })).toMatch(/^Error: /);
    expect(calls(toolbox)).toEqual(["get_token_info:failed"]);
  });
});

const v4Usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const toolCalls = (...list: [string, Record<string, unknown>][]) => ({
  content: list.map(([toolName, input], i) => ({
    type: "tool-call" as const,
    toolCallId: `t${i}-${toolName}`,
    toolName,
    input: JSON.stringify(input),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: v4Usage(50, 10),
  warnings: [],
});

describe("@bonded/sdk/ai-sdk", () => {
  it("generateText with the episode's tools reads and trades, and reports usage", async () => {
    const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
    const model = new MockLanguageModelV4({
      doGenerate: [
        toolCalls(["read_news", {}], ["get_portfolio", {}]),
        toolCalls(["swap", SWAP]),
        {
          content: [{ type: "text", text: "Done: bought tNVDA." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: v4Usage(50, 10),
          warnings: [],
        },
      ],
    });
    const text = await runAiSdkEpisode(episode, model);
    expect(text).toBe("Done: bought tNVDA.");
    const firstCall = model.doGenerateCalls[0]!;
    expect(firstCall.tools?.map((t) => t.name)).toContain("swap");
    // The second step saw the Arena's output for the reads.
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toMatch(/tool-result/);
    expect(calls(toolbox)).toEqual(["read_news:ok", "get_portfolio:ok", "swap:ok"]);
    expect(await balance("tNVDA")).toBeGreaterThan(0n);
    await expect(gatewayEpisode.done).resolves.toEqual({
      finalMessage: "Done: bought tNVDA.",
      usage: { inputTokens: 150, outputTokens: 30 },
    });
  });
});

describe("@bonded/sdk/agentkit", () => {
  it("an AgentKit action provider exposes the episode's tools", async () => {
    const { episode, toolbox, balance } = await arena.episode();
    const walletProvider = new ViemWalletProvider(
      createWalletClient({
        account: privateKeyToAccount(`0x${"ab".repeat(32)}`),
        chain: arena.sandbox.chain,
        transport: http(arena.sandbox.rpcUrl),
      }) as never,
    );
    const kit = await agentKitFor({ walletProvider, actionProviders: [], episode });
    const actions = kit.getActions();
    const action = (name: string) =>
      actions.find((a) => a.name === `BondedEpisodeActionProvider_${name}`)!;
    expect(actions.map((a) => a.name)).toContain("BondedEpisodeActionProvider_read_market_alerts");

    // The schema AgentKit hands its framework extensions checks arguments like the Arena does.
    expect(action("swap").schema.safeParse(SWAP).success).toBe(true);
    expect(action("swap").schema.safeParse({ ...SWAP, amountIn: "lots" }).success).toBe(false);

    // A scripted model picks the actions; AgentKit invokes them.
    for (const [name, args] of [
      ["read_counterparty_messages", {}],
      ["swap", SWAP],
    ] as const)
      await action(name).invoke(args);
    expect(calls(toolbox)).toEqual(["read_counterparty_messages:ok", "swap:ok"]);
    expect(await balance("tNVDA")).toBeGreaterThan(0n);
    expect(await action("get_token_info").invoke({ symbol: "NOPE" })).toMatch(/^Error: /);
  });
});

describe("@bonded/sdk/eliza rating mode", () => {
  /** An Eliza runtime whose OBJECT_SMALL model reads parameters from a script. */
  const runtime = (answers: Record<string, unknown>[]): ElizaRuntime => ({
    useModel: async () => answers.shift() ?? {},
  });
  const memory = (text: string) => ({ content: { text } });

  it("swaps the vault actions for the episode's tools while an episode runs", async () => {
    const { episode, toolbox, balance } = await arena.episode();
    const env = envFor(episode);
    const vault = new BondedVault({
      vault: episode.vault,
      chain: arena.sandbox.chain,
      account: privateKeyToAccount(`0x${"cd".repeat(32)}`),
    });
    const plugin = bondedPlugin({ vault });
    expect(plugin.actions.map((a) => a.name)).toEqual([
      "BONDED_SWAP",
      "BONDED_TRANSFER",
      "BONDED_APPROVE",
    ]);

    // The runtime calls init before it reads the actions; with BONDED_* set, rating mode is on.
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      await plugin.init!({}, {});
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    const names = plugin.actions.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["READ_INBOX", "GET_PRICES", "SWAP"]));
    expect(names).not.toContain("BONDED_SWAP");
    const task = await plugin.providers[0]!.get(runtime([]), memory(""), {});
    expect(task.text).toContain(TASK.goal);

    const action = (name: string) => plugin.actions.find((a) => a.name === name)!;
    const rt = runtime([SWAP]);
    const read = await action("READ_SOCIAL").handler(rt, memory("check the feed"));
    expect(read.success).toBe(true);
    const replies: string[] = [];
    const swap = await action("SWAP").handler(
      rt,
      memory("buy 300 tUSDG of tNVDA"),
      undefined,
      {},
      async (r) => {
        replies.push(r.text ?? "");
      },
    );
    expect(swap.success).toBe(true);
    expect(replies[0]).toMatch(/tNVDA/);
    expect(calls(toolbox)).toEqual(["read_social:ok", "swap:ok"]);
    expect(await balance("tNVDA")).toBeGreaterThan(0n);
  });

  it("in chain mode: read tools, plus vault actions signed with the session key", async () => {
    const { episode, toolbox, balance } = await arena.episode("chain");
    const plugin = bondedEpisodePlugin({ episode });
    await plugin.init!({}, {});
    const names = plugin.actions.map((a) => a.name);
    expect(names).toContain("READ_NEWS");
    expect(names).not.toContain("SWAP");
    expect(names).toContain("BONDED_SWAP");

    const action = (name: string) => plugin.actions.find((a) => a.name === name)!;
    expect((await action("READ_NEWS").handler(runtime([]), memory(""))).success).toBe(true);
    const swap = await action("BONDED_SWAP").handler(runtime([]), memory(""), undefined, {
      parameters: { tokenIn: "tUSDG", tokenOut: "tNVDA", amount: "300" },
    });
    expect(swap).toMatchObject({ success: true, data: { breaches: [] } });
    // The signed transactions went through the episode's RPC to the vault (approve, then swap).
    expect(calls(toolbox)).toEqual(["read_news:ok", "execute:ok", "execute:ok"]);
    expect(await balance("tNVDA")).toBeGreaterThan(0n);
    expect(await balance("tUSDG")).toBeLessThan(parseUnits("50000", 6));
  });
});
