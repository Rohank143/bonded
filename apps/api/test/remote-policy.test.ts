import { describe, expect, it } from "vitest";
import { HOSTED_REMOTE_PROFILE } from "@bonded/arena";
import { REMOTE_EPISODE_TIMEOUT_MS } from "../src/remote-agent.js";
import {
  DEFAULT_REMOTE_POLICY,
  remotePolicyFromEnv,
  remoteQuota,
  remoteRatingPlan,
} from "../src/remote-policy.js";

describe("remotePolicyFromEnv", () => {
  it("is the defaults with nothing set", () => {
    expect(remotePolicyFromEnv({})).toEqual(DEFAULT_REMOTE_POLICY);
  });

  it("takes every setting from the environment, one source for the API, worker and bounties", () => {
    const policy = remotePolicyFromEnv({
      REMOTE_REPEATS: "2",
      REMOTE_RATINGS_PER_OWNER_DAILY: "7",
      REMOTE_RATINGS_PER_AGENT_DAILY: "4",
      REMOTE_RATINGS_DAILY: "50",
      REMOTE_EPISODE_BUDGET_MS: "30000",
      REMOTE_RATING_MAX_MS: "3600000",
      REMOTE_RATING_INTERVAL_MS: "600000",
      HELD_OUT_FRESH_PER_CLASS: "2",
    });
    expect(policy).toEqual({
      repeats: 2,
      perOwnerDaily: 7,
      perAgentDaily: 4,
      laneDaily: 50,
      episodeBudgetMs: 30_000,
      budgetCeilingMs: 3_600_000,
      perAgentMs: 600_000,
      heldOutPerClass: 2,
    });
    expect(remoteQuota(policy, 5)).toEqual({
      nowMs: 5,
      perOwnerDaily: 7,
      perAgentDaily: 4,
      laneDaily: 50,
    });
    expect(remoteRatingPlan(policy, { publishedAttacks: 50, heldOut: 10 })).toEqual({
      episodes: 126,
      budgetMs: 3_600_000,
    });
  });

  it("refuses a setting that isn't a positive whole number", () => {
    expect(() => remotePolicyFromEnv({ REMOTE_RATINGS_DAILY: "0" })).toThrow();
    expect(() => remotePolicyFromEnv({ REMOTE_REPEATS: "two" })).toThrow();
    expect(() => remotePolicyFromEnv({ REMOTE_RATING_INTERVAL_MS: "-1" })).toThrow();
    expect(() => remotePolicyFromEnv({ HELD_OUT_FRESH_PER_CLASS: "6" })).toThrow();
    // No wait between ratings, and no held-out set, are allowed (local runs and tests).
    expect(remotePolicyFromEnv({ REMOTE_RATING_INTERVAL_MS: "0" }).perAgentMs).toBe(0);
    expect(remotePolicyFromEnv({ HELD_OUT_FRESH_PER_CLASS: "0" }).heldOutPerClass).toBe(0);
  });

  it("matches the hosted profile the arena CLI runs locally", () => {
    expect(DEFAULT_REMOTE_POLICY.repeats).toBe(HOSTED_REMOTE_PROFILE.repeats);
    expect(DEFAULT_REMOTE_POLICY.heldOutPerClass).toBe(HOSTED_REMOTE_PROFILE.heldOutPerClass);
    expect(REMOTE_EPISODE_TIMEOUT_MS).toBe(HOSTED_REMOTE_PROFILE.episodeTimeoutMs);
  });
});
