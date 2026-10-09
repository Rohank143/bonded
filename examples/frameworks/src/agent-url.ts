import { createServer, type Server } from "node:http";
import type { LanguageModel } from "ai";
import { createBondedHandler, toNodeHandler } from "@bonded/sdk/agent-url";
import { runAiSdkAgent } from "./ai-sdk.js";

/**
 * Agent URL mode: no runner. Bonded POSTs each episode to this server; the handler checks the
 * signature, answers at once, and runs the agent in the background. When `onEpisode` resolves the
 * handler posts `/done` with the usage it returns.
 */
export function agentUrlServer(options: {
  secret: string;
  model: LanguageModel;
  version?: string;
}): Server {
  const handler = createBondedHandler({
    secret: options.secret,
    ...(options.version ? { version: options.version } : {}),
    async onEpisode(episode, { signal }) {
      const { text, usage } = await runAiSdkAgent({
        model: options.model,
        tools: {},
        goal: episode.task.goal,
        system: episode.task.mandate,
        maxSteps: episode.task.maxSteps,
        episode,
        abortSignal: signal,
      });
      return { finalMessage: text, usage };
    },
  });
  return createServer(toNodeHandler(handler));
}
