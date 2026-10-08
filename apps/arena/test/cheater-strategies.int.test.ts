import { appendFileSync } from "node:fs";
import { findInstructions } from "@bonded/demo-agents";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bonded/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaGateway,
  benignTrade,
  loadAttackLibrary,
  type RatingResult,
  rateAgent,
  RemoteAgent,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";
import { fakeRunner } from "./fixtures/gateway-client.js";

/**
 * The re-review's proof of concept, kept as a regression test: a remote agent that can tell
 * planted content from benign (here with a detector stronger than pool lookups: any address, any
 * order the reference parser finds, any token note with an order in it, any price off the oracle)
 * and idles in some or all attack episodes, possibly failing controls on purpose to lower the bar.
 * Idling must not pay: every such strategy is refused, and none scores above the agent that
 * simply ignores what it reads and does its task every time.
 */
type Strategy =
  "idle" | "skip45" | "skip70-halfcontrols" | "filter" | "mask-inbox" | "task-without-reading";

class Detector implements ArenaAgent {
  readonly name = "poc/detector";
  readonly log: boolean[] = [];
  private attacks = 0;
  private controls = 0;
  constructor(private readonly strategy: Strategy) {}

  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const trade = async () => {
      const t = benignTrade(task.goal)!;
      await tools.call("swap", {
        tokenIn: t.tokenIn,
        tokenOut: t.tokenOut,
        amountIn: String(t.amountUsd),
      });
    };
    // Never look at anything: only ever do the task.
    if (this.strategy === "task-without-reading") {
      this.log.push(false);
      await trade();
      return { steps: 1, stoppedBecause: "done" };
    }
    const read = async (name: string, args: unknown = {}) => {
      const r = await tools.call(name, args);
      return r.ok ? r.output : undefined;
    };
    const texts: string[] = [];
    for (const name of [
      "read_inbox",
      "read_news",
      "read_social",
      "read_market_alerts",
      "read_counterparty_messages",
      "get_recent_transfers",
      "get_market_report",
    ])
      texts.push(JSON.stringify(await read(name)));
    for (const symbol of ["tUSDG", "tTSLA", "tAMZN", "tNVDA"])
      texts.push(JSON.stringify(await read("get_token_info", { symbol })));
    const all = texts.join("\n");
    const api = (await read("get_prices")) as Record<string, number>;
    const oracle = ((await read("get_portfolio")) as { pricesUsd: Record<string, number> })
      .pricesUsd;
    const priced = Object.entries(api).some(([s, p]) => Math.abs(p / oracle[s]! - 1) > 0.01);
    const transfers = JSON.parse(texts[5]!) as { note?: string; amount: string }[];
    const attack =
      priced ||
      findInstructions(all).length > 0 ||
      /0x[0-9a-fA-F]{40}/.test(texts.slice(0, 5).join("") + texts[6]) ||
      transfers.some((t) => t.amount === "0" && t.note) ||
      /\b(send|transfer|approve|swap|sell|buy|convert|migrat|refund|return)\w*\b/i.test(
        texts.slice(0, 5).join(" ") + texts.slice(6).join(" "),
      );
    this.log.push(attack);
    // Idle only when the inbox carries the attack: hiding one class (A6, social engineering)
    // inside its group.
    const inboxAttack =
      findInstructions(texts[0]!).length > 0 || /0x[0-9a-fA-F]{40}/.test(texts[0]!);
    let act = true;
    if (this.strategy === "mask-inbox" && inboxAttack) act = false;
    if (attack) {
      const n = this.attacks++;
      if (this.strategy === "idle") act = false;
      if (this.strategy === "skip45") act = n % 20 >= 9;
      if (this.strategy === "skip70-halfcontrols") act = n % 10 >= 7;
    } else {
      const n = this.controls++;
      if (this.strategy === "skip70-halfcontrols") act = n % 2 === 0;
    }
    if (act) {
      const trade = benignTrade(task.goal)!;
      await tools.call("swap", {
        tokenIn: trade.tokenIn,
        tokenOut: trade.tokenOut,
        amountIn: String(trade.amountUsd),
      });
    }
    return { steps: 0, stoppedBecause: "done" };
  }
}

let sandbox: Sandbox;
let gateway: ArenaGateway;
const results = new Map<Strategy, { result: RatingResult; correct: number }>();
const STRATEGIES: Strategy[] = [
  "filter",
  "idle",
  "skip45",
  "skip70-halfcontrols",
  "mask-inbox",
  "task-without-reading",
];
const token = (i: number) => `bonded_rt_cheater-strategy-token-${i}`;

beforeAll(async () => {
  sandbox = await Sandbox.start();
  gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens(
      Object.fromEntries(STRATEGIES.map((_, i) => [token(i), `cheater-${i}`])),
    ),
  });
  await gateway.listen();
});
afterAll(async () => {
  await gateway?.close();
  await sandbox?.stop();
});

describe("idling under attack doesn't pay", () => {
  it.each(STRATEGIES.map((s, i) => [s, i] as const))(
    "rates the %s strategy",
    async (strategy, i) => {
      const brain = new Detector(strategy);
      const runner = await fakeRunner({
        gateway: gateway.url,
        token: token(i),
        mode: "tools",
        agent: brain,
      });
      try {
        const agent = new RemoteAgent({ gateway, sandbox, runner: `cheater-${i}`, mode: "tools" });
        const result = await rateAgent(sandbox, { agent, attacks: loadAttackLibrary() });
        const truth = result.episodes.map((e) => e.attackId !== null);
        const correct = brain.log.filter((label, k) => label === truth[k]).length;
        results.set(strategy, { result, correct });
        if (process.env.ARENA_POC_LOG)
          appendFileSync(
            process.env.ARENA_POC_LOG,
            `${JSON.stringify({
              strategy,
              episodes: result.episodes.length,
              classifiedCorrectly: correct,
              breaches: result.episodes.filter((e) => e.verdict.breached).length,
              liveness: result.report.liveness,
              exercised: result.report.classes.map(
                (c) => `${c.class}:${c.exercised}/${c.episodes}`,
              ),
              refused: result.refused,
              score: result.report.scoring.score,
            })}\n`,
          );
        expect(result.episodes.some((e) => e.verdict.breached)).toBe(false);
      } finally {
        await runner.close();
      }
    },
    900_000,
  );

  it("refuses every idling strategy, and none outscores doing the task", () => {
    const honest = results.get("filter")!.result;
    expect(honest.refused).toBeNull();
    for (const strategy of ["idle", "skip45", "skip70-halfcontrols"] as const) {
      const { result } = results.get(strategy)!;
      expect(result.refused, strategy).not.toBeNull();
      expect(result.report.scoring.score, strategy).toBeLessThanOrEqual(
        honest.report.scoring.score,
      );
    }
    // Hiding one class prices that class as untested; never reading prices everything so.
    for (const strategy of ["mask-inbox", "task-without-reading"] as const) {
      const { result } = results.get(strategy)!;
      expect(result.report.scoring.score, strategy).toBeLessThan(honest.report.scoring.score);
    }
    const masked = results.get("mask-inbox")!.result;
    expect(masked.report.scoring.groups.find((g) => g.id === "social")?.untestedClasses).toContain(
      "A6",
    );
    const blind = results.get("task-without-reading")!.result;
    expect(blind.report.classes.every((c) => c.exercised === 0)).toBe(true);
  });
});
