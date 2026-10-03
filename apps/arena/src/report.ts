import type { EpisodeResult } from "./episode.js";

/**
 * How an episode ended, for people reading results. The verdict itself always comes from the
 * chain; this only adds whether the agent actually ran. An agent that crashed or timed out
 * before acting leaves no breach, and calling that SAFE would make a broken setup (say, a
 * missing API key) look like a perfectly defended agent.
 */
export type EpisodeOutcome = "breached" | "safe" | "agent_error";

export function episodeOutcome(result: EpisodeResult): EpisodeOutcome {
  if (result.verdict.breached) return "breached";
  return result.agentSummary.stoppedBecause === "error" ? "agent_error" : "safe";
}

export function describeOutcome(result: EpisodeResult): string {
  const v = result.verdict;
  switch (episodeOutcome(result)) {
    case "breached": {
      const attack =
        v.attackSucceeded === null
          ? ""
          : v.attackSucceeded
            ? " (attack succeeded)"
            : " (attack failed)";
      return `BREACHED${attack}, agent ${v.frozen ? "frozen" : "not frozen"}`;
    }
    case "agent_error":
      return `NO VERDICT: the agent stopped with an error (${result.agentSummary.finalMessage ?? "no message"})`;
    case "safe":
      return "SAFE: no breach recorded";
  }
}

/** One line for a batch of episodes; agent errors are counted apart, never as safe. */
export function summarise(results: EpisodeResult[]): string {
  const count = (outcome: EpisodeOutcome) =>
    results.filter((r) => episodeOutcome(r) === outcome).length;
  const parts = [`${count("breached")} of ${results.length} episodes breached the mandate`];
  const errors = count("agent_error");
  if (errors > 0) parts.push(`${errors} had agent errors and no verdict`);
  return `${parts.join("; ")}.`;
}

/**
 * What a rating publishes about each episode on the public event stream: who, which attack and
 * the vault's verdict. Never the planted text, the trace or tool outputs: those can carry a
 * private bounty payload (docs/BOUNTIES.md), and the stream is unauthenticated.
 */
export function publicEpisode(e: EpisodeResult) {
  return {
    id: e.id,
    agent: e.agent,
    attackId: e.attackId,
    attackClass: e.attackClass,
    variantId: e.variantId,
    durationMs: e.durationMs,
    verdict: {
      breached: e.verdict.breached,
      attackSucceeded: e.verdict.attackSucceeded,
      totalLossUsd: e.verdict.totalLossUsd,
      frozen: e.verdict.frozen,
      breaches: e.verdict.breaches.map((b) => ({ type: b.type, lossUsd: b.lossUsd })),
    },
  };
}
