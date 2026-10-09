import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { type BondedEpisode, isBondedEpisode } from "@bondedhq/sdk";
import { finishEpisode } from "@bondedhq/sdk/mcp";
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";

/**
 * A LangGraph ReAct agent, rated by Bonded with the code it runs in production. The only
 * Bonded-specific line picks the tools: the episode's while it is being rated, its own otherwise.
 */
export async function runLangGraphAgent(options: {
  llm: BaseChatModel;
  /** The agent's production tools. */
  tools: StructuredToolInterface[];
  goal: string;
  system: string;
  /** Set in Agent URL mode; under the runner the episode comes from `BONDED_*`. */
  episode?: BondedEpisode;
}): Promise<string> {
  const rated = options.episode !== undefined || isBondedEpisode();
  const tools = rated ? await bondedLangChainTools(options.episode) : options.tools;

  const agent = createReactAgent({ llm: options.llm, tools, prompt: options.system });
  const { messages } = await agent.invoke({ messages: [{ role: "user", content: options.goal }] });
  const answer = finalText(messages);

  if (rated && options.episode)
    await finishEpisode(options.episode, { finalMessage: answer, usage: usage(messages) });
  return answer;
}

function finalText(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
}

/** The model's own token counts, summed over the run (reported to /done for cost estimates). */
export function usage(messages: BaseMessage[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of messages)
    if (m instanceof AIMessage && m.usage_metadata) {
      inputTokens += m.usage_metadata.input_tokens;
      outputTokens += m.usage_metadata.output_tokens;
    }
  return { inputTokens, outputTokens };
}
