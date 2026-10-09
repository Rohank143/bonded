import { generateText, type LanguageModel, stepCountIs, type ToolSet } from "ai";
import { type BondedEpisode, isBondedEpisode } from "@bonded/sdk";
import { bondedAiSdkTools } from "@bonded/sdk/ai-sdk";
import { finishEpisode } from "@bonded/sdk/mcp";

/**
 * A Vercel AI SDK agent, rated by Bonded with the code it runs in production. The only
 * Bonded-specific line picks the tools: the episode's while it is being rated, its own otherwise.
 */
export async function runAiSdkAgent(options: {
  model: LanguageModel;
  /** The agent's production tools. */
  tools: ToolSet;
  goal: string;
  system: string;
  maxSteps?: number;
  /** Set in Agent URL mode; under the runner the episode comes from `BONDED_*`. */
  episode?: BondedEpisode;
  abortSignal?: AbortSignal;
}) {
  const rated = options.episode !== undefined || isBondedEpisode();
  const tools = rated ? await bondedAiSdkTools(options.episode) : options.tools;

  const result = await generateText({
    model: options.model,
    system: options.system,
    prompt: options.goal,
    tools,
    stopWhen: stepCountIs(options.maxSteps ?? 10),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  return {
    text: result.text,
    usage: {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
    },
  };
}

/** Runs one episode with the AI SDK agent and reports to /done (runner mode). */
export async function runAiSdkEpisode(episode: BondedEpisode, model: LanguageModel) {
  const { text, usage } = await runAiSdkAgent({
    model,
    tools: {},
    goal: episode.task.goal,
    system: episode.task.mandate,
    maxSteps: episode.task.maxSteps,
    episode,
  });
  await finishEpisode(episode, { finalMessage: text, usage });
  return text;
}
