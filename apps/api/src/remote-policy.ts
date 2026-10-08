import { HOSTED_REMOTE_PROFILE, REMOTE_CONTROLS } from "@bonded/arena";
import type { RemoteQuota } from "@bonded/db";
import { z } from "zod";

/**
 * The rules for rating agents their operators run (bring your own agent): how big a rating is,
 * how long it may take, and how often one may be asked for. They exist so one operator can't hold
 * the rating worker, crowd out others, or reroll a rating until it comes out well.
 */
export interface RemoteRatingPolicy {
  /** Runs of each published attack (default 3; built-in designs use 5). */
  repeats: number;
  /** Remote ratings per owner, across their agents, per 24 hours (default 3). */
  perOwnerDaily: number;
  /** Remote ratings per agent per 24 hours (default 2). */
  perAgentDaily: number;
  /** Remote ratings on the chain per 24 hours, all owners together (default 20). */
  laneDaily: number;
  /** Time allowed per episode when working out a rating's budget (default 40 s). */
  episodeBudgetMs: number;
  /** The most any remote rating may take (default 3 hours). */
  budgetCeilingMs: number;
  /**
   * At most one rating per agent in this many milliseconds (default one hour): owner requests,
   * and re-ratings after a TEE change.
   */
  perAgentMs: number;
  /** Held-out variants made per attack class for each rating alone (default 1, at most 5). */
  heldOutPerClass: number;
}

export const DEFAULT_REMOTE_POLICY: RemoteRatingPolicy = {
  // The hosted profile's size, which `pnpm arena rate --profile hosted` also runs.
  repeats: HOSTED_REMOTE_PROFILE.repeats,
  perOwnerDaily: 3,
  perAgentDaily: 2,
  laneDaily: 20,
  episodeBudgetMs: 40_000,
  budgetCeilingMs: 3 * 3_600_000,
  perAgentMs: 3_600_000,
  heldOutPerClass: HOSTED_REMOTE_PROFILE.heldOutPerClass,
};

/**
 * The policy as configured: the defaults, with any of REMOTE_REPEATS,
 * REMOTE_RATINGS_PER_OWNER_DAILY, REMOTE_RATINGS_PER_AGENT_DAILY, REMOTE_RATINGS_DAILY,
 * REMOTE_EPISODE_BUDGET_MS, REMOTE_RATING_MAX_MS, REMOTE_RATING_INTERVAL_MS and
 * HELD_OUT_FRESH_PER_CLASS set in the environment. Every path that
 * rates an operator-run agent (owner requests, renewals, TEE re-ratings) reads it here. Bounty
 * acceptances don't re-rate them: bounty attacks are never run against an agent its operator runs.
 */
export function remotePolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RemoteRatingPolicy {
  const int = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(env[name] ?? fallback);
  const d = DEFAULT_REMOTE_POLICY;
  return {
    repeats: int("REMOTE_REPEATS", d.repeats),
    perOwnerDaily: int("REMOTE_RATINGS_PER_OWNER_DAILY", d.perOwnerDaily),
    perAgentDaily: int("REMOTE_RATINGS_PER_AGENT_DAILY", d.perAgentDaily),
    laneDaily: int("REMOTE_RATINGS_DAILY", d.laneDaily),
    episodeBudgetMs: int("REMOTE_EPISODE_BUDGET_MS", d.episodeBudgetMs, 1000),
    budgetCeilingMs: int("REMOTE_RATING_MAX_MS", d.budgetCeilingMs, 60_000),
    perAgentMs: int("REMOTE_RATING_INTERVAL_MS", d.perAgentMs, 0),
    heldOutPerClass: int("HELD_OUT_FRESH_PER_CLASS", d.heldOutPerClass, 0, 5),
  };
}

/** The policy's caps, as the database applies them at `nowMs`. */
export function remoteQuota(policy: RemoteRatingPolicy, nowMs: number): RemoteQuota {
  return {
    nowMs,
    perOwnerDaily: policy.perOwnerDaily,
    perAgentDaily: policy.perAgentDaily,
    laneDaily: policy.laneDaily,
  };
}

/**
 * A remote rating's size and time budget: every published attack `repeats` times, the held-out
 * set made for it, and the controls; `budgetMs` is the episodes at `episodeBudgetMs` each, never
 * more than the ceiling.
 */
export function remoteRatingPlan(
  policy: RemoteRatingPolicy,
  input: { publishedAttacks: number; repeats?: number; heldOut: number },
): { episodes: number; budgetMs: number } {
  const episodes =
    (input.publishedAttacks + input.heldOut) * (input.repeats ?? policy.repeats) + REMOTE_CONTROLS;
  return {
    episodes,
    budgetMs: Math.min(policy.budgetCeilingMs, episodes * policy.episodeBudgetMs),
  };
}

/** Plain words for a remote rating the caps or the cooldown refuse. */
export function remoteRefusalMessage(
  refusal:
    | { refused: "cooldown"; nextAt: Date }
    | { refused: "owner-daily" | "agent-daily" | "lane-daily" },
  policy: RemoteRatingPolicy,
): string {
  switch (refusal.refused) {
    case "cooldown":
      return `the agent's last rating was stopped by the agent, so the next waits until ${refusal.nextAt.toISOString()} (the wait doubles with each stop in a row, up to 48 hours)`;
    case "owner-daily":
      return `at most ${policy.perOwnerDaily} ratings a day per owner, across their agents; try again tomorrow`;
    case "agent-daily":
      return `at most ${policy.perAgentDaily} ratings a day per agent; try again tomorrow`;
    case "lane-daily":
      return "today's ratings of operator-run agents are used up; try again tomorrow";
  }
}
