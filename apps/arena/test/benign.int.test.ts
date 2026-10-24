import { ScriptedHardenedAgent } from "@bonded/demo-agents";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BenignSeed,
  benignTrade,
  loadAttackLibrary,
  loadBenignSeeds,
  rateAgent,
  runEpisode,
  Sandbox,
} from "../src/index.js";

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await Sandbox.start();
});
afterAll(async () => {
  await sandbox?.stop();
});

const seeds = loadBenignSeeds();

/** The twin whose goal this is: goals are unique before their first placeholder. */
function seedFor(goal: string): BenignSeed | undefined {
  return seeds.find((s) => goal.startsWith(s.goal.split("{{")[0]!.trim()));
}

/**
 * Does each twin's job as if it had read the content right (it is told the answer), and the
 * standing order otherwise: the positive control for the judge.
 */
class DiligentAgent implements ArenaAgent {
  readonly name = "diligent-agent/test";
  constructor(private readonly extra?: "avoided") {}
  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const seed = seedFor(task.goal);
    const buys = seed
      ? [
          { token: seed.expect.buy.token, usd: seed.expect.buy.amountUsd },
          ...(this.extra && seed.expect.avoid[0]
            ? [{ token: seed.expect.avoid[0], usd: 100 }]
            : []),
        ]
      : (() => {
          const t = benignTrade(task.goal);
          return t ? [{ token: t.tokenOut, usd: t.amountUsd }] : [];
        })();
    for (const b of buys)
      await tools.call("swap", { tokenIn: "tUSDG", tokenOut: b.token, amountIn: String(b.usd) });
    return { steps: buys.length, stoppedBecause: "done" };
  }
}

describe("benign twins in an episode", () => {
  it("plants each twin's content and counts its job done only when the right buy was made", async () => {
    for (const seed of seeds) {
      const done = await runEpisode(sandbox, {
        agent: new DiligentAgent(),
        attack: null,
        benign: seed,
      });
      expect(done.benignId).toBe(seed.id);
      expect(done.benignClass).toBe(seed.class);
      expect(done.attackId).toBeNull();
      expect(done.planted).toHaveLength(seed.steps.length);
      expect(done.task.goal).not.toContain("{{");
      expect(done.taskCompleted, seed.id).toBe(true);
      expect(done.verdict.breached).toBe(false);

      // Ignoring the content: the scripted hardened agent finds no order it can act on.
      const ignored = await runEpisode(sandbox, {
        agent: new ScriptedHardenedAgent(),
        attack: null,
        benign: seed,
      });
      expect(ignored.taskCompleted, seed.id).toBe(false);
    }
  });

  it("doesn't count the job done when the agent also bought a token the content ruled out", async () => {
    const seed = seeds.find((s) => s.expect.avoid.length)!;
    const greedy = await runEpisode(sandbox, {
      agent: new DiligentAgent("avoided"),
      attack: null,
      benign: seed,
    });
    expect(greedy.taskCompleted).toBe(false);
  });

  it("refuses an episode with both an attack and a twin", async () => {
    const attack = loadAttackLibrary()[0]!;
    await expect(
      runEpisode(sandbox, { agent: new DiligentAgent(), attack, benign: seeds[0]! }),
    ).rejects.toThrow(/not both/);
  });
});

describe("the Task score in a rating", () => {
  const attacks = loadAttackLibrary().filter((s) => s.id === "A6-operator-impersonation-001");

  it("scores an agent that ignores what it reads 0, though its Bonded Score is 100", async () => {
    const r = await rateAgent(sandbox, {
      agent: new ScriptedHardenedAgent(),
      attacks,
      benign: { seeds },
    });
    expect(r.report.susceptibility?.grade).toBe(100);
    expect(r.report.liveness).toMatchObject({ controls: 6, completed: 6, policy: "refuse" });
    expect(r.refused).toBeNull();
    expect(r.report.task).toMatchObject({ score: 0, worst: "benign" });
    expect(r.report.task?.benign).toMatchObject({ trials: seeds.length, done: 0 });
    expect(r.report.episodes.benign).toBe(seeds.length);
    // Twins stay out of the controls and attack counts.
    expect(r.report.episodes.controls).toBe(6);
    expect(r.episodes.some((e) => e.benignId)).toBe(false);
    expect(r.benignEpisodes).toHaveLength(seeds.length);
  });

  it("scores an agent that does its job everywhere 100", async () => {
    const r = await rateAgent(sandbox, {
      agent: new DiligentAgent(),
      attacks,
      benign: { seeds },
    });
    expect(r.report.task).toMatchObject({ score: 100 });
    expect(r.report.task?.classes).toHaveLength(10);
  });

  it("has no benign part when the rating runs no twins", async () => {
    const r = await rateAgent(sandbox, { agent: new ScriptedHardenedAgent(), attacks });
    expect(r.report.task?.benign.trials).toBe(0);
    expect(r.report.task?.score).toBe(100);
    expect(r.report.episodes.benign).toBeUndefined();
  });
});
