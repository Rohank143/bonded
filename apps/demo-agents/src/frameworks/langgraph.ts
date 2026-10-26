import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { type AgentRunSummary, type AgentTask, llmConfigFromEnv } from "@bondedhq/shared";

/**
 * Both framework templates (AgentKit's LangChain chatbot, Solana Agent Kit's LangGraph example)
 * run a LangGraph ReAct agent: the model picks a tool, the tool runs, repeat until it answers.
 * This runs that loop with the framework's tools and its template prompt, and reports the run.
 */

/** The operator's message: the Arena's task and the mandate, as an operator would give them. */
export function taskMessage(task: AgentTask): string {
  return `${task.goal}\n\nYour mandate: ${task.mandate}`;
}

/**
 * How long one model request may take before it's abandoned and tried again. A flash model
 * answers in seconds; without a limit, a request the provider never finishes hung until the
 * episode's own limit (15 minutes in a leaderboard rating) and failed the episode, which fails
 * the rating (the Oct 26 re-rating lost both AgentKit entries this way).
 */
export const MODEL_REQUEST_TIMEOUT_MS = 90_000;
/** Tries after the first for a request that timed out or dropped: at most about 6 minutes. */
export const MODEL_REQUEST_RETRIES = 3;

/**
 * A chat model on OpenRouter (or LLM_BASE_URL), the way the templates create theirs. It keeps
 * each raw response on the message: LangChain drops the `usage.cost` OpenRouter reports, and the
 * run's spend should be that cost, not an estimate from token counts. Each request has a time
 * limit and is retried when it times out or the connection drops, so one provider hiccup costs a
 * retry, not the episode. The prompt, the tools and the model's settings are the template's.
 */
export function openRouterModel(
  model: string,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): BaseChatModel {
  const { baseUrl, apiKey } = llmConfigFromEnv();
  return new ChatOpenAI({
    model,
    apiKey,
    configuration: { baseURL: baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) },
    temperature: 0,
    timeout: options.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS,
    maxRetries: MODEL_REQUEST_RETRIES,
    __includeRawResponse: true,
  });
}

/** The cost the endpoint reported for one model turn (OpenRouter's `usage.cost`), if any. */
export function reportedCost(message: AIMessage): number | undefined {
  const raw = message.additional_kwargs.__raw_response as
    { usage?: { cost?: unknown } } | undefined;
  const metadata = message.response_metadata.usage as { cost?: unknown } | undefined;
  const cost = raw?.usage?.cost ?? metadata?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export async function runLangGraphAgent(options: {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  prompt: string;
  task: AgentTask;
  signal?: AbortSignal;
  /** Tool calls made so far, from the adapter's bridge. */
  steps: () => number;
}): Promise<AgentRunSummary> {
  const agent = createReactAgent({
    llm: options.model,
    tools: options.tools,
    prompt: options.prompt,
  });
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  // The summary carries a cost only when every model turn reported one, so a spending cap
  // never takes a partial cost for the whole run.
  let turns = 0;
  let uncosted = 0;
  let messages: unknown[] = [];
  let finalMessage: string | undefined;
  let stoppedBecause: AgentRunSummary["stoppedBecause"] = "done";
  try {
    const result = await agent.invoke(
      { messages: [new HumanMessage(taskMessage(options.task))] },
      // Each step is a model turn plus a tool turn.
      {
        recursionLimit: 2 * options.task.maxSteps + 2,
        // Completed model turns are billable even if a later turn or the graph fails.
        callbacks: [
          {
            handleLLMEnd(output) {
              for (const generations of output.generations) {
                for (const generation of generations) {
                  if ("message" in generation && generation.message instanceof AIMessage) {
                    usage.inputTokens += generation.message.usage_metadata?.input_tokens ?? 0;
                    usage.outputTokens += generation.message.usage_metadata?.output_tokens ?? 0;
                    const cost = reportedCost(generation.message);
                    turns++;
                    if (cost === undefined) uncosted++;
                    else usage.costUsd += cost;
                  }
                }
              }
            },
          },
        ],
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    messages = result.messages;
  } catch (error) {
    stoppedBecause =
      error instanceof Error && error.name === "GraphRecursionError" ? "max_steps" : "error";
    finalMessage = error instanceof Error ? error.message : String(error);
  }
  for (const m of messages) {
    if (m instanceof AIMessage) {
      if (typeof m.content === "string" && m.content) finalMessage = m.content;
    }
  }
  const steps = Math.max(options.steps(), messages.filter((m) => m instanceof ToolMessage).length);
  return {
    steps,
    stoppedBecause,
    ...(finalMessage ? { finalMessage: finalMessage.slice(0, 2000) } : {}),
    usage:
      turns > 0 && uncosted === 0
        ? usage
        : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
