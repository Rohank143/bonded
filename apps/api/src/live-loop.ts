import type { Database, RemoteQuota } from "@bonded/db";

/**
 * The live loop for agents their operators run (bring your own agent): scores are renewed while
 * the agent's runner is connected, so a score lapses only when the runner is away. The other
 * triggers live where their causes do: a TEE change in tee-watch.ts, an accepted bounty in the
 * database's `finishBounty`.
 */

/** Re-rate a connected agent once its score has this little time left, in seconds (3 days). */
export const RENEW_BEFORE_EXPIRY_SECONDS = 3 * 86_400;

/** After a renewal attempt, wait this long before another (6 hours), so a failing one can't loop. */
export const RENEW_RETRY_MS = 6 * 3_600_000;

/**
 * Queues a rating for every remote agent on the chain whose runner is connected and whose score
 * expires within `RENEW_BEFORE_EXPIRY_SECONDS` (or already has), unless it was tried recently, it
 * is in a cooldown or over its caps (`quota`: renewals count like any rating), or `problem` says
 * it can't be rated (owner changed, no bond). Returns the agents queued.
 */
export async function renewExpiringScores(
  db: Database,
  chainId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  options: {
    quota?: RemoteQuota;
    problem?: (agentKey: string) => Promise<string | undefined>;
  } = {},
): Promise<string[]> {
  const queued: string[] = [];
  for (const agent of await db.remoteAgentsExpiring(
    chainId,
    nowSeconds + RENEW_BEFORE_EXPIRY_SECONDS,
  )) {
    const problem = await options.problem?.(agent);
    if (problem) {
      await db.recordRatingSkip(agent, "renewal", `the score couldn't be renewed: ${problem}`);
      continue;
    }
    if (await db.enqueueIfIdle(agent, RENEW_RETRY_MS, options.quota)) queued.push(agent);
  }
  return queued;
}
