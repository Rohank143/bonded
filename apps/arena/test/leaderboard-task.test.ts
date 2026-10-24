import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACK_LIBRARY_VERSION, LeaderboardEntry, TASK_SCORE_VERSION } from "@bondedhq/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryTask } from "../src/leaderboard.js";
import { planTask, runTaskRefresh, taskArgs, type TaskJob } from "../src/leaderboard-task.js";
import type { TaskBatteryResult } from "../src/task-battery.js";
import { taskScore } from "../src/task-score.js";

const entry = (slug: string, over: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  slug,
  name: slug,
  kind: "framework",
  framework: "Coinbase AgentKit",
  model: "deepseek/deepseek-v4.1-flash",
  ratedAt: "2026-10-19T21:54:19.592Z",
  libraryVersion: ATTACK_LIBRARY_VERSION,
  securityGrade: 70,
  score: 60,
  tier: "BBB",
  expectedLossBps: 100,
  premiumRateBps: 200,
  insurable: true,
  episodes: { attacks: 350, controls: 2, controlBreaches: 0 },
  classes: [],
  reportHash: `0x${"ab".repeat(32)}`,
  onchain: { chain: "robinhoodTestnet", agentId: "4", tx: `0x${"cd".repeat(32)}` },
  disclosure: { status: "pending" },
  ...over,
});
const scripted = entry("bonded-hardened-scripted", {
  kind: "reference",
  framework: "Bonded demo agent (scripted)",
  model: null,
});
const llm = entry("agentkit-deepseek");

type Ep = Parameters<typeof taskScore>[0][number];
const ep = (done: boolean, benign = false): Ep => ({
  attackId: null,
  taskCompleted: done,
  verdict: { breached: false } as Ep["verdict"],
  agentSummary: { steps: 1, stoppedBecause: "done" },
  ...(benign ? { benignId: "B-A6-pm-order-001", benignClass: "A6" as const } : {}),
});
const times = <T>(n: number, make: () => T) => Array.from({ length: n }, make);

function taskJson(dir: string, opts: { benignDone: boolean; spentUsd?: number; stopped?: string }) {
  const result: TaskBatteryResult = {
    agent: "test",
    startedAt: "2026-10-25T10:00:00.000Z",
    durationMs: 1,
    task: taskScore(
      times(6, () => ep(true)),
      times(11, () => ep(opts.benignDone, true)),
    ),
    spend: {
      spentUsd: opts.spentUsd ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
    } as TaskBatteryResult["spend"],
    stoppedEarly: opts.stopped ?? null,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(result));
}

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "task-"));
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("leaderboard task", () => {
  it("plans every entry without a current Task score, and estimates only model spend", () => {
    const current = entry("current", {
      task: entryTask(
        taskScore(
          times(6, () => ep(true)),
          [],
        ),
        "2026-10-25T10:00:00.000Z",
        "task",
      ),
    });
    const plan = planTask({ entries: [scripted, llm, current], runDir });
    expect(plan.jobs.map((j) => j.entry.slug)).toEqual([
      "bonded-hardened-scripted",
      "agentkit-deepseek",
    ]);
    expect(plan.skipped).toEqual([
      { slug: "current", reason: `Task score already on version ${TASK_SCORE_VERSION}` },
    ]);
    expect(plan.estimateUsd).toBeCloseTo(0.05);
    expect(planTask({ entries: [current], runDir, force: true }).jobs).toHaveLength(1);
  });

  it("runs arena task with the entry's agent and model, and caps only model-driven ones", () => {
    const [job] = planTask({ entries: [llm], runDir }).jobs;
    expect(taskArgs(job!, { episodeTimeoutS: 900 }, 0.25)).toEqual([
      "task",
      "--agent",
      "agentkit",
      "--model",
      "deepseek/deepseek-v4.1-flash",
      "--episode-timeout",
      "900",
      "--max-usd",
      "0.25",
      "--out",
      join(runDir, "agentkit-deepseek"),
    ]);
    const [own] = planTask({ entries: [scripted], runDir }).jobs;
    expect(taskArgs(own!, { episodeTimeoutS: 900 }, 0.25)).toEqual([
      "task",
      "--agent",
      "hardened",
      "--brain",
      "scripted",
      "--episode-timeout",
      "900",
      "--out",
      join(runDir, "bonded-hardened-scripted"),
    ]);
  });

  it("adds the Task score to each entry and leaves its grades as they were", async () => {
    const plan = planTask({ entries: [scripted, llm], runDir });
    const ran: string[] = [];
    const { entries, outcomes } = await runTaskRefresh(
      plan,
      [scripted, llm],
      { episodeTimeoutS: 900, maxUsd: 1 },
      {
        run: async (job: TaskJob) => {
          ran.push(job.entry.slug);
          taskJson(job.dir, { benignDone: job.target.brain === "llm", spentUsd: 0.02 });
          return 0;
        },
        log: () => {},
      },
    );
    expect(ran).toHaveLength(2);
    const hardened = entries.find((e) => e.slug === scripted.slug)!;
    expect(hardened.task).toMatchObject({ score: 0, worst: "benign", source: "task" });
    expect(hardened.task?.underAttack.trials).toBe(0);
    expect(hardened.securityGrade).toBe(scripted.securityGrade);
    expect(hardened.reportHash).toBe(scripted.reportHash);
    expect(entries.find((e) => e.slug === llm.slug)!.task?.score).toBe(100);
    for (const e of entries) expect(LeaderboardEntry.parse(e)).toEqual(e);
    expect(outcomes.map((o) => o.status)).toEqual(["measured", "measured"]);
  });

  it("reuses a finished run, and measures again one that stopped early", async () => {
    const plan = planTask({ entries: [scripted, llm], runDir });
    taskJson(plan.jobs[0]!.dir, { benignDone: false });
    taskJson(plan.jobs[1]!.dir, { benignDone: true, stopped: "spending cap" });
    const ran: string[] = [];
    const { outcomes } = await runTaskRefresh(
      plan,
      [scripted, llm],
      { episodeTimeoutS: 900, maxUsd: 1 },
      {
        run: async (job) => {
          ran.push(job.entry.slug);
          taskJson(job.dir, { benignDone: true });
          return 0;
        },
        log: () => {},
      },
    );
    expect(ran).toEqual(["agentkit-deepseek"]);
    expect(outcomes.map((o) => o.status)).toEqual(["reused", "measured"]);
  });

  it("needs a spending cap for a model-driven entry, and stops at it", async () => {
    const plan = planTask({ entries: [llm], runDir });
    const deps = { run: async () => 0, log: () => {} };
    await expect(runTaskRefresh(plan, [llm], { episodeTimeoutS: 900 }, deps)).rejects.toThrow(
      /--max-usd/,
    );
    const two = planTask({ entries: [llm, entry("other")], runDir });
    const { outcomes, entries } = await runTaskRefresh(
      two,
      [llm, entry("other")],
      { episodeTimeoutS: 900, maxUsd: 0.05 },
      {
        run: async (job) => {
          taskJson(job.dir, { benignDone: true, spentUsd: 0.05 });
          return 0;
        },
        log: () => {},
      },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["measured", "failed"]);
    expect(outcomes[1]!.reason).toMatch(/spending cap/);
    expect(entries.find((e) => e.slug === "other")!.task).toBeUndefined();
  });

  it("records a failed run without touching the entry", async () => {
    const plan = planTask({ entries: [scripted], runDir });
    const { outcomes, entries } = await runTaskRefresh(
      plan,
      [scripted],
      { episodeTimeoutS: 900 },
      { run: async () => 1, log: () => {} },
    );
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "arena task exited with 1" });
    expect(entries[0]).toEqual(scripted);
  });
});
