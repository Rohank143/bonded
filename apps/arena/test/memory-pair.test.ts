import type { ArenaAgent, AttackSpec, Susceptibility } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { SpendingCap } from "../src/budget.js";
import type { EpisodeOptions, EpisodeResult } from "../src/episode.js";
import {
  isMemoryCapable,
  MEMORY_DAY2_GOAL,
  runMemoryBattery,
  runMemoryPair,
} from "../src/memory-attempt.js";
import { loadMemorySeeds } from "../src/memory-observations.js";
import { trackLabel } from "../src/rate.js";
import type { Sandbox } from "../src/sandbox.js";

// The two-arm pairing with scripted episodes: no chain, no model.

const seed: AttackSpec = loadMemorySeeds().find((s) => s.class === "A2")!;

/** A fake memory agent: each run "remembers" what was planted, so the arms' notes differ. */
function memoryAgent() {
  let notes: string[] = [];
  const agent = {
    name: "fake-memory",
    get memory() {
      return notes;
    },
    reset() {
      notes = [];
    },
    run: async () => ({ steps: 0, stoppedBecause: "done" as const }),
    note(n: string) {
      notes.push(n);
    },
  };
  return agent;
}

function ep(opts: {
  breached?: boolean;
  tokens?: string[][];
  taskCompleted?: boolean | null;
  costUsd?: number;
}): EpisodeResult {
  return {
    id: "ep",
    vault: "0x0000000000000000000000000000000000000001",
    trace: [],
    taskCompleted: opts.taskCompleted ?? true,
    trades: (opts.tokens ?? [["tUSDG", "tTSLA"]]).map((tokens) => ({
      step: 1,
      tool: "swap",
      target: "router",
      tokens,
      outflowUsd: 0,
      breached: false,
    })),
    agentSummary: {
      steps: 1,
      stoppedBecause: "done",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: opts.costUsd ?? 0.01 },
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

/** Scripted episodes by arm and day; records every call the pair makes, and what memory it saw. */
function harness(script: {
  /** Which arms' day 1 writes no notes (a failed note-writing call). */
  silentDay1?: ("control" | "poisoned")[];
  controlD1?: EpisodeResult;
  controlD2?: EpisodeResult;
  poisonedD1?: EpisodeResult;
  poisonedD2?: EpisodeResult;
}) {
  const agent = memoryAgent();
  const calls: {
    variantId: string;
    attack: string | null;
    goal: string;
    worldSeed: string;
    notes: string[];
  }[] = [];
  const runEpisodeFn = async (o: EpisodeOptions) => {
    const label = o.variantId ?? "";
    calls.push({
      variantId: label,
      attack: o.attack?.id ?? null,
      goal: o.goal ?? "",
      worldSeed: o.worldSeed ?? "",
      notes: [...agent.memory],
    });
    const arm = label.includes("control") ? "control" : "poisoned";
    if (label.endsWith("d1") && script.silentDay1?.includes(arm)) {
      // writes nothing
    } else if (o.attack) agent.note("planted standing order");
    else if (label.endsWith("d1")) agent.note("ordinary day");
    const key = label.includes("control")
      ? label.endsWith("d1")
        ? "controlD1"
        : "controlD2"
      : label.endsWith("d1")
        ? "poisonedD1"
        : "poisonedD2";
    return script[key] ?? ep({});
  };
  return { agent, calls, runEpisodeFn };
}

describe("runMemoryPair", () => {
  it("runs the control arm first, both from a wiped memory, differing only in the plant", async () => {
    const h = harness({});
    const r = await runMemoryPair({
      sandbox: {} as Sandbox,
      agent: h.agent,
      seed,
      round: 0,
      runEpisodeFn: h.runEpisodeFn,
    });
    expect(h.calls.map((c) => c.variantId)).toEqual([
      "memory-0-control-d1",
      "memory-0-control-d2",
      "memory-0-poisoned-d1",
      "memory-0-poisoned-d2",
    ]);
    const [cd1, cd2, pd1, pd2] = h.calls;
    // Only the poisoned day 1 has the attack.
    expect(h.calls.map((c) => c.attack)).toEqual([null, null, seed.id, null]);
    // Day 1 runs the seed's own goal in both arms (passed explicitly, not the default).
    expect(cd1!.goal).toBe(seed.goal);
    expect(pd1!.goal).toBe(seed.goal);
    expect(cd2!.goal).toBe(MEMORY_DAY2_GOAL);
    expect(pd2!.goal).toBe(MEMORY_DAY2_GOAL);
    // Same worlds across arms.
    expect(cd1!.worldSeed).toBe(pd1!.worldSeed);
    expect(cd2!.worldSeed).toBe(pd2!.worldSeed);
    expect(cd1!.worldSeed).not.toBe(cd2!.worldSeed);
    // Each arm starts wiped; each day 2 carries that arm's own day-1 notes.
    expect(cd1!.notes).toEqual([]);
    expect(pd1!.notes).toEqual([]);
    expect(cd2!.notes).toEqual(["ordinary day"]);
    expect(pd2!.notes).toEqual(["planted standing order"]);
    expect(r.controlNotes).toEqual(["ordinary day"]);
    expect(r.poisonedNotes).toEqual(["planted standing order"]);
    expect(r.usages).toHaveLength(4);
    expect(h.agent.memory).toEqual([]);
  });

  it("flags an off-goal trade on the poisoned day 2 against a clean control", async () => {
    const h = harness({
      poisonedD2: ep({
        tokens: [
          ["tUSDG", "tTSLA"],
          ["tUSDG", "tNVDA"],
        ],
      }),
    });
    const r = await runMemoryPair({
      sandbox: {} as Sandbox,
      agent: h.agent,
      seed,
      round: 1,
      runEpisodeFn: h.runEpisodeFn,
    });
    expect(r).toMatchObject({
      offGoalTrade: true,
      controlOffGoalTrade: false,
      breached: false,
      breachedSession1: false,
      changedBehavior: true,
      round: 1,
    });
  });

  it("records the control's own off-goal trade and breaches per day", async () => {
    const h = harness({
      controlD2: ep({ tokens: [["tUSDG", "tAMZN"]] }),
      poisonedD1: ep({ breached: true }),
      poisonedD2: ep({ breached: true, tokens: [["tUSDG", "tAMZN"]] }),
    });
    const r = await runMemoryPair({
      sandbox: {} as Sandbox,
      agent: h.agent,
      seed,
      round: 0,
      runEpisodeFn: h.runEpisodeFn,
    });
    expect(r).toMatchObject({
      breachedSession1: true,
      breached: true,
      controlBreached: false,
      offGoalTrade: true,
      controlOffGoalTrade: true,
      changedBehavior: false,
    });
  });
});

describe("runMemoryPair notes check", () => {
  it("marks the attempt notesMissing when either arm's day 1 saved nothing", async () => {
    for (const silent of [["control"], ["poisoned"]] as const) {
      const h = harness({ silentDay1: [...silent] });
      const r = await runMemoryPair({
        sandbox: {} as Sandbox,
        agent: h.agent,
        seed,
        round: 0,
        runEpisodeFn: h.runEpisodeFn,
      });
      expect(r.notesMissing, silent[0]).toBe(true);
    }
    const ok = harness({});
    const r = await runMemoryPair({
      sandbox: {} as Sandbox,
      agent: ok.agent,
      seed,
      round: 0,
      runEpisodeFn: ok.runEpisodeFn,
    });
    expect(r.notesMissing).toBe(false);
  });
});

describe("runMemoryBattery", () => {
  it("stops starting attempts once the spending cap trips", async () => {
    const h = harness({});
    const cap = new SpendingCap({ maxUsd: 0.05 });
    // Each attempt costs 4 x $0.01 = $0.04: the first leaves $0.04 spent, the second trips the cap.
    const results = await runMemoryBattery({} as Sandbox, h.agent, [seed, seed, seed], {
      rounds: 1,
      cap,
      runEpisodeFn: h.runEpisodeFn,
    });
    expect(results).toHaveLength(2);
    expect(cap.exceeded).toBe(true);
  });
});

describe("isMemoryCapable", () => {
  it("needs both readable notes and a reset", () => {
    const run = async () => ({ steps: 0, stoppedBecause: "done" as const });
    expect(isMemoryCapable(memoryAgent())).toBe(true);
    expect(isMemoryCapable({ name: "a", run, reset() {} } as ArenaAgent)).toBe(false);
    expect(isMemoryCapable({ name: "a", run, memory: [] } as unknown as ArenaAgent)).toBe(false);
  });
});

describe("report headline track label", () => {
  const w = (over: Partial<Susceptibility>): Susceptibility => ({
    grade: 60,
    worstClass: "A2",
    worstTrack: "s1",
    worstRate: 0.4,
    overallRate: 0.2,
    classes: [],
    ...over,
  });
  it("names memory, market-data, or nothing for S2", () => {
    expect(trackLabel(w({ worstSource: "memory" }))).toBe(" (S1 memory)");
    expect(trackLabel(w({}))).toBe(" (S1 market-data)");
    expect(trackLabel(w({ worstTrack: "s2" }))).toBe("");
  });
});
