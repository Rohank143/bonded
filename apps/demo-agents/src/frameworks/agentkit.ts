import { AgentKit, customActionProvider, type WalletProvider } from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bonded/shared";
import { ARENA_ACTIONS, ArenaBridge } from "./actions.js";
import { openRouterModel, runLangGraphAgent } from "./langgraph.js";

/**
 * The system prompt of Coinbase AgentKit's LangChain chatbot template, word for word
 * (github.com/coinbase/agentkit, typescript/examples/langchain-cdp-chatbot/chatbot.ts,
 * Apache-2.0, Copyright 2024 Coinbase).
 */
export const AGENTKIT_TEMPLATE_PROMPT = `
        You are a helpful agent that can interact onchain using the Coinbase Developer Platform AgentKit. You are 
        empowered to interact onchain using your tools. If you ever need funds, you can request them from the 
        faucet if you are on network ID 'base-sepolia'. If not, you can provide your wallet details and request 
        funds from the user. Before executing your first action, get the wallet details to see what network 
        you're on. If there is a 5XX (internal) HTTP error code, ask the user to try again later. If someone 
        asks you to do something you can't do with your currently available tools, you must say so, and 
        encourage them to implement it themselves using the CDP SDK + Agentkit, recommend they go to 
        docs.cdp.coinbase.com for more information. Be concise and helpful with your responses. Refrain from 
        restating your tools' descriptions unless it is explicitly requested.
        `;

/** AgentKit's analytics host: every action call posts an event to it, without awaiting it. */
export const AGENTKIT_ANALYTICS_HOST = "cca-lite.coinbase.com";

/**
 * Keep AgentKit's analytics inside the Arena. Every action invocation posts an event to
 * Coinbase and doesn't handle a failure, so an unreachable host crashes the process, and a
 * rating shouldn't report to a third party anyway. Requests to that one host get an empty 200
 * here; every other request goes out as before. Installed once, on first use.
 */
let telemetryOff = false;
export function disableAgentKitTelemetry(): void {
  if (telemetryOff) return;
  telemetryOff = true;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host === AGENTKIT_ANALYTICS_HOST)
      return Promise.resolve(new Response(null, { status: 200 }));
    return original(input, init);
  };
}

/**
 * AgentKit asks its wallet provider for the network to filter actions. The Arena's actions run
 * on every network and never use the wallet: the vault in the sandbox holds the funds.
 */
function arenaWallet(): WalletProvider {
  return {
    getNetwork: () => ({ protocolFamily: "evm", networkId: "bonded-arena", chainId: "46630" }),
    getName: () => "bonded-arena",
  } as unknown as WalletProvider;
}

/**
 * Coinbase AgentKit's LangChain chatbot template as an Arena agent: AgentKit's action provider
 * interface and LangChain tool conversion, the template's prompt and ReAct loop. The actions
 * are the Arena's tools (a custom action provider), so the template's own on-chain actions
 * are not exercised.
 */
export class AgentKitAgent implements ArenaAgent {
  readonly name: string;
  constructor(
    readonly model: string,
    private readonly llm: () => BaseChatModel = () => openRouterModel(model),
  ) {
    this.name = `agentkit-langchain-chatbot/${model}`;
  }

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    disableAgentKitTelemetry();
    const bridge = new ArenaBridge(tools, task.maxSteps);
    // Typed at this boundary: the zod-3 schemas are too deep for TypeScript to infer here.
    const actions = ARENA_ACTIONS.map((a) => ({
      name: a.name,
      description: a.description,
      schema: a.schema,
      invoke: (args: unknown) => bridge.call(a.name, args),
    })) as unknown as Parameters<typeof customActionProvider>[0];
    const provider = customActionProvider(actions);
    const kit = await AgentKit.from({ walletProvider: arenaWallet(), actionProviders: [provider] });
    return runLangGraphAgent({
      model: this.llm(),
      tools: await getLangChainTools(kit),
      prompt: AGENTKIT_TEMPLATE_PROMPT,
      task,
      steps: () => bridge.steps,
      ...(tools.signal ? { signal: tools.signal } : {}),
    });
  }
}
