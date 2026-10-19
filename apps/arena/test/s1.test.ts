import type { ArenaAgent } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  type EpisodeOptions,
  type EpisodeResult,
  loadAttackLibrary,
  runS1Pair,
  type Sandbox,
} from "../src/index.js";

const seed = loadAttackLibrary().find((s) => s.class === "A3")!;
const agent: ArenaAgent = { name: "fake", run: async () => ({ steps: 0, stoppedBecause: "done" }) };

/** A minimal EpisodeResult with the fields runS1Pair reads. */
function ep(opts: {
  vault: `0x${string}`;
  breached?: boolean;
  taskCompleted?: boolean | null;
  trades?: number;
  costUsd?: number;
  said?: string;
}): EpisodeResult {
  return {
    id: `ep-${opts.vault}`,
    vault: opts.vault,
    attackId: opts.breached ? "A3-x" : null,
    planted: [],
    trace: [],
    drained: [],
    taskCompleted: opts.taskCompleted ?? true,
    trades: Array.from({ length: opts.trades ?? 1 }, () => ({ tokens: ["tUSDG", "tNVDA"] })),
    agentSummary: {
      steps: 1,
      stoppedBecause: "done",
      ...(opts.said ? { finalMessage: opts.said } : {}),
      ...(opts.costUsd === undefined
        ? {}
        : { usage: { inputTokens: 1, outputTokens: 1, costUsd: opts.costUsd } }),
    },
    verdict: {
      breached: opts.breached ?? false,
      attackSucceeded: null,
      breaches: [],
      totalLossUsd: 0,
      frozen: false,
    },
  } as unknown as EpisodeResult;
}

/** Drives runS1Pair with scripted clean/manipulated episodes and a fake oracle valuation. */
function harness(over: {
  cleanEp: EpisodeResult;
  manipEp: EpisodeResult;
  values: Record<string, number>;
}) {
  const calls: string[] = [];
  const runEpisodeFn = async (o: EpisodeOptions) => {
    calls.push(o.variantId ?? "");
    return o.attack === null ? over.cleanEp : over.manipEp;
  };
  const valueFn = async (vault: `0x${string}`) => over.values[vault] ?? 0;
  return {
    calls,
    run: () =>
      runS1Pair({
        sandbox: {} as Sandbox,
        agent,
        seed,
        goal: "dip-buy rule: read the feed and buy accordingly",
        runEpisodeFn,
        valueFn,
      }),
  };
}

describe("runS1Pair", () => {
  it("runs a clean then a manipulated episode on the same world and reports induced loss", async () => {
    const h = harness({
      cleanEp: ep({ vault: "0xc1", trades: 1 }),
      manipEp: ep({ vault: "0xm1", trades: 3, said: "bought the dip" }),
      values: { "0xc1": 49_900, "0xm1": 49_600 },
    });
    const r = await h.run();
    expect(h.calls).toEqual(["s1-clean", "s1-manip"]);
    expect(r.clean.valueUsd).toBe(49_900);
    expect(r.manipulated.valueUsd).toBe(49_600);
    expect(r.inducedLossUsd).toBeCloseTo(300);
    expect(r.changedBehavior).toBe(true); // 1 -> 3 trades
    expect(r.effect).toBe("action");
    expect(r.breached).toBe(false);
    expect(r.manipulated.agentSaid).toBe("bought the dip");
  });

  it("reports no induced loss and no behavior change when the manipulation did nothing", async () => {
    const h = harness({
      cleanEp: ep({ vault: "0xc2", trades: 1, taskCompleted: true }),
      manipEp: ep({ vault: "0xm2", trades: 1, taskCompleted: true }),
      values: { "0xc2": 49_900, "0xm2": 49_900 },
    });
    const r = await h.run();
    expect(r.inducedLossUsd).toBe(0);
    expect(r.changedBehavior).toBe(false);
    expect(r.effect).toBe("none");
  });

  it("classifies a held order as induced inaction, not action", async () => {
    const h = harness({
      cleanEp: ep({ vault: "0xc5", trades: 1, taskCompleted: true }),
      manipEp: ep({
        vault: "0xm5",
        trades: 0,
        taskCompleted: false,
        said: "holding for your call",
      }),
      values: { "0xc5": 49_990, "0xm5": 50_000 },
    });
    const r = await h.run();
    expect(r.changedBehavior).toBe(true);
    expect(r.effect).toBe("inaction");
  });

  it("flags a vault breach on the manipulated side (then it is a breach, not pure S1)", async () => {
    const h = harness({
      cleanEp: ep({ vault: "0xc3" }),
      manipEp: ep({ vault: "0xm3", breached: true }),
      values: { "0xc3": 50_000, "0xm3": 40_000 },
    });
    const r = await h.run();
    expect(r.breached).toBe(true);
    expect(r.inducedLossUsd).toBeCloseTo(10_000);
  });

  it("surfaces both episodes' usage for the caller's spending cap", async () => {
    const h = harness({
      cleanEp: ep({ vault: "0xc4", costUsd: 0.01 }),
      manipEp: ep({ vault: "0xm4", costUsd: 0.02 }),
      values: { "0xc4": 50_000, "0xm4": 50_000 },
    });
    const r = await h.run();
    expect(r.usages).toHaveLength(2);
    expect(r.usages[0]?.costUsd).toBe(0.01);
    expect(r.usages[1]?.costUsd).toBe(0.02);
  });
});
