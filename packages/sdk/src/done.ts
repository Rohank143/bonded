import type { DoneRequest } from "@bondedhq/shared";
import { BondedError } from "./errors.js";

/**
 * Tells the gateway the agent is finished: `POST {done}` with an optional final message and the
 * agent's own model usage (tokens, cost), which Bonded uses to estimate what a full rating costs
 * you. Exiting the process (runner) or the deadline also ends the episode.
 */
export async function finishEpisode(
  episode: { endpoints: { done: string } },
  body: DoneRequest = {},
  options: { fetch?: typeof fetch } = {},
): Promise<void> {
  const response = await (options.fetch ?? fetch)(episode.endpoints.done, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new BondedError(
      "EPISODE_DONE",
      `the gateway refused /done: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
}
