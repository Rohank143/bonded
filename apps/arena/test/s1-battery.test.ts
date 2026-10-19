import { describe, expect, it, vi } from "vitest";
import { SpendingCap } from "../src/budget.js";
import { loadS1Seeds } from "../src/s1-observations.js";
import { runS1Battery, s1BatterySettings } from "../src/s1-battery.js";
import { runS1Pair, type S1PairResult, type S1Options } from "../src/s1.js";
import type { EpisodeResult } from "../src/episode.js";

const seed = loadS1Seeds()[0]!;
const agent = { name: "test", run: async () => ({ steps: 0, stoppedBecause: "done" as const }) };
const sandbox = {} as S1Options["sandbox"];
describe("inline S1 battery", () => {
  it("keeps conditional goals and rejects invalid settings before work", () => {
    expect(s1BatterySettings([seed]).seeds[0]!.goal).toBe(seed.goal);
    for (const pairs of [0, -1, 1.5, Infinity])
      expect(() => s1BatterySettings([seed], pairs)).toThrow();
    expect(() => s1BatterySettings([{ ...seed, goal: undefined }])).toThrow(/goal/);
  });
  it("passes the shared cap and hook into every pair, retains completed work on exhaustion", async () => {
    const budget = new SpendingCap({ maxUsd: 1 });
    const onEpisode = vi.fn();
    const runPair = vi.fn<typeof runS1Pair>(async (options) => {
      expect(options.budget).toBe(budget);
      expect(options.onEpisode).toBe(onEpisode);
      expect(options.goal).toBe(seed.goal);
      budget.add({ inputTokens: 1, outputTokens: 1, costUsd: 1 });
      return { seed: seed.id } as S1PairResult;
    });
    const result = await runS1Battery(
      { sandbox, agent, seeds: [seed], pairs: 2, budget, onEpisode },
      runPair,
    );
    expect(result).toMatchObject({ stoppedEarly: true, results: [{ seed: seed.id }] });
    expect(runPair).toHaveBeenCalledTimes(1);
  });
  it("charges a clean arm and calls its hook before refusing to start the manipulated arm", async () => {
    const budget = new SpendingCap({ maxUsd: 1 });
    const onEpisode = vi.fn();
    const runEpisodeFn = vi.fn(
      async () =>
        ({
          id: "clean",
          vault: "0x1",
          agentSummary: {
            stoppedBecause: "done",
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
          },
          verdict: { breached: false },
          trades: [],
        }) as unknown as EpisodeResult,
    );
    const result = await runS1Battery({
      sandbox,
      agent,
      seeds: [seed],
      pairs: 2,
      budget,
      onEpisode,
      runEpisodeFn,
      valueFn: async () => 50000,
    });
    expect(result).toEqual({ stoppedEarly: true, results: [] });
    expect(runEpisodeFn).toHaveBeenCalledTimes(1);
    expect(onEpisode).toHaveBeenCalledTimes(1);
    expect(budget.exceeded).toBe(true);
  });
});
