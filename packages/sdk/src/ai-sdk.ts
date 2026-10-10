import { jsonSchema, type Tool, tool } from "ai";
import { SENTINEL_INPUT_CHARS } from "@bondedhq/shared";
import type { GuardContext } from "./guarded.js";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools } from "./mcp.js";
import type { SentinelInput } from "./sentinel.js";
import {
  BONDED_VAULT_TOOLS,
  type BondedVaultToolsOptions,
  bondedVaultTools,
} from "./vault-tools.js";

export type { BondedVaultToolsOptions } from "./vault-tools.js";

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

/**
 * The agent's Mandate Vault as an AI SDK tool set, for production: `swap`, `transfer`, `approve`
 * and `vault_status`, every write sent through `BondedVault` so the vault checks it against the
 * mandate. Each write is dry-run first and refused on a predicted breach (`guard`, on by
 * default). With `sentinel`, Sentinel is asked too; what the agent read is taken from the tool
 * results earlier in the conversation, unless you pass `context`. A refusal or failure returns
 * `{ error }`, so the model can react.
 *
 * The names and arguments match the episode's write tools, so the agent's prompts work the same
 * while it is rated:
 *
 * ```ts
 * const tools = isBondedEpisode()
 *   ? await bondedAiSdkTools()
 *   : { ...productionTools, ...bondedVaultAiSdkTools({ vault }) };
 * ```
 */
export function bondedVaultAiSdkTools(options: BondedVaultToolsOptions): Record<string, Tool> {
  return Object.fromEntries(
    bondedVaultTools(options).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          t.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: Record<string, unknown>, call?: { messages?: unknown[] }) => {
          const context: GuardContext | undefined =
            options.sentinel && !options.context
              ? { untrustedInputs: toolResultsIn(call?.messages ?? []) }
              : undefined;
          const result = await t.call(args ?? {}, context);
          return result.ok ? result.output : { error: result.error };
        },
      }),
    ]),
  );
}

/** The tool results the model has seen (the last 20), as Sentinel's untrusted inputs. */
function toolResultsIn(messages: unknown[]): SentinelInput[] {
  const own = new Set<string>(BONDED_VAULT_TOOLS);
  const inputs: SentinelInput[] = [];
  for (const message of messages) {
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string; output?: unknown }[]) {
      if (part.type !== "tool-result" || !part.toolName || own.has(part.toolName)) continue;
      const out = part.output as { type?: string; value?: unknown } | undefined;
      const value = out && typeof out === "object" && "value" in out ? out.value : out;
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      inputs.push({ tool: part.toolName, output: text.slice(0, SENTINEL_INPUT_CHARS) });
    }
  }
  return inputs.slice(-20);
}
