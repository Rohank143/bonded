/**
 * RATING HOOK (to be filled in by the Arena gateway work, Track B).
 *
 * The same agent, rated where it runs: the Arena gateway hands the runner an episode (a task,
 * MCP/HTTP tool endpoints, and in chain mode a fork RPC, a session key and a vault), and the
 * agent acts through them exactly as it does in production. This module is where that wiring
 * goes: read the episode from the BONDED_* environment the runner sets, point `runOnce` at the
 * episode's tools and vault, and report done.
 *
 * Until then, `rate` refuses clearly instead of pretending.
 */
export async function rate(): Promise<never> {
  throw new Error(
    "Rating this agent through the Arena gateway isn't available yet. Protection works today: run without --rate.",
  );
}
