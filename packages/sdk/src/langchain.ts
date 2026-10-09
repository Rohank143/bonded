import { DynamicStructuredTool } from "@langchain/core/tools";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools, resultText } from "./mcp.js";

/**
 * The episode's tools as LangChain `StructuredTool`s, for LangChain and LangGraph agents
 * (`createReactAgent`, `ToolNode`, `model.bindTools`). Each takes the tool's own JSON Schema and
 * returns what the Arena returned, as text; a failed call returns `Error: ...` so the model can
 * react, as it would to a production tool.
 *
 * With no argument it reads the episode from the runner's `BONDED_*` variables. Switch to them
 * only while being rated:
 *
 * ```ts
 * const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
 * const agent = createReactAgent({ llm, tools });
 * ```
 *
 * Peer dependency: `@langchain/core` 1.
 */
export async function bondedLangChainTools(
  from?: EpisodeTools | EpisodeToolsSource,
): Promise<DynamicStructuredTool[]> {
  const episode = await resolveTools(from);
  return episode.tools.map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        func: async (args: Record<string, unknown>) => resultText(await t.call(args ?? {})),
      }),
  );
}
