import { DynamicStructuredTool } from "@langchain/core/tools";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools, resultText } from "./mcp.js";
import { type BondedVaultToolsOptions, bondedVaultTools } from "./vault-tools.js";

export type { BondedVaultToolsOptions } from "./vault-tools.js";

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

/**
 * The agent's Mandate Vault as LangChain tools, for production: `swap`, `transfer`, `approve`
 * and `vault_status`, every write sent through `BondedVault` so the vault checks it against the
 * mandate. Each write is dry-run first and refused on a predicted breach (`guard`, on by
 * default); with `sentinel`, Sentinel is asked too, with what `context()` says the agent read.
 * A refusal or failure comes back as `Error: ...` text, so the model can react.
 *
 * The names and arguments match the episode's write tools, so the agent's prompts work the same
 * while it is rated:
 *
 * ```ts
 * const tools = isBondedEpisode()
 *   ? await bondedLangChainTools()
 *   : [...productionTools, ...bondedVaultLangChainTools({ vault })];
 * ```
 */
export function bondedVaultLangChainTools(
  options: BondedVaultToolsOptions,
): DynamicStructuredTool[] {
  return bondedVaultTools(options).map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        func: async (args: Record<string, unknown>) => resultText(await t.call(args ?? {})),
      }),
  );
}
