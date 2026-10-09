import { jsonSchema, type Tool, tool } from "ai";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools } from "./mcp.js";

/**
 * The episode's tools as a Vercel AI SDK tool set, for `generateText`/`streamText`/agents. Each
 * keeps the tool's own JSON Schema; `execute` returns the Arena's output, or `{ error }` when the
 * call failed, so the model can react as it would to a production tool.
 *
 * With no argument it reads the episode from the runner's `BONDED_*` variables. Switch to them
 * only while being rated:
 *
 * ```ts
 * const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
 * await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: task.goal });
 * ```
 *
 * Peer dependency: `ai` 5 or later (tested with 7).
 */
export async function bondedAiSdkTools(
  from?: EpisodeTools | EpisodeToolsSource,
): Promise<Record<string, Tool>> {
  const episode = await resolveTools(from);
  return Object.fromEntries(
    episode.tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          t.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: Record<string, unknown>) => {
          const result = await t.call(args ?? {});
          return result.ok ? result.output : { error: result.error };
        },
      }),
    ]),
  );
}
