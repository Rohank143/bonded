import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bonded/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaToolbox,
  createAgentVault,
  loadAttackLibrary,
  marketTokens,
  runEpisode,
  Sandbox,
  World,
} from "../src/index.js";

let sandbox: Sandbox;
const agent = new ScriptedVulnerableAgent();
const library = loadAttackLibrary();

beforeAll(async () => {
  sandbox = await Sandbox.start();
});
afterAll(async () => {
  await sandbox?.stop();
});

describe("episodes on a fresh local chain", () => {
  it("control: the agent does its task and the verdict is SAFE", async () => {
    const result = await runEpisode(sandbox, { agent, attack: null });
    expect(result.verdict).toMatchObject({ breached: false, attackSucceeded: null, frozen: false });
    const swap = result.trace.find((s) => s.tool === "swap");
    expect(swap?.result.ok).toBe(true);
    expect(swap?.txHashes.length).toBeGreaterThan(0);
  });

  it.each(library.map((spec) => [spec.id, spec] as const))(
    "%s: the vulnerable agent is breached and the judge says so",
    async (_, spec) => {
      const result = await runEpisode(sandbox, { agent, attack: spec });
      expect(result.verdict.breached).toBe(true);
      expect(result.verdict.attackSucceeded).toBe(true);
      expect(result.verdict.frozen).toBe(true);
      expect(result.planted).toHaveLength(spec.surfaces.length);
      // Once frozen, the agent's real task is refused by the vault.
      const swap = result.trace.find((s) => s.tool === "swap");
      expect(swap?.result).toEqual({ ok: false, error: "reverted: AgentFrozen" });
    },
  );

  it("Enforce mode blocks the transfer but still records the attempt", async () => {
    const spec = library.find((s) => s.id === "A6-operator-impersonation-001")!;
    const result = await runEpisode(sandbox, {
      agent,
      attack: spec,
      vault: { mandate: { mode: "enforce" } },
    });
    expect(result.verdict.breached).toBe(true);
    expect(result.verdict.breaches[0]).toMatchObject({
      type: "T1_UNAUTHORIZED_TRANSFER",
      blocked: true,
      lossUsd: 0,
    });
  });

  it("judges from the chain, not from what the agent claims", async () => {
    // An agent that reports success without doing anything harmful, and one that breaches
    // but reports nothing: only the vault's record decides.
    const liar: ArenaAgent = {
      name: "liar",
      async run(): Promise<AgentRunSummary> {
        return {
          steps: 0,
          stoppedBecause: "done",
          finalMessage: "I sent everything to the attacker",
        };
      },
    };
    const quiet: ArenaAgent = {
      name: "quiet",
      async run(_: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
        await tools.call("transfer", {
          token: "tUSDG",
          to: "0x000000000000000000000000000000000000dEaD",
          amount: "1",
        });
        return { steps: 1, stoppedBecause: "done", finalMessage: "all good" };
      },
    };
    expect((await runEpisode(sandbox, { agent: liar, attack: null })).verdict.breached).toBe(false);
    expect((await runEpisode(sandbox, { agent: quiet, attack: null })).verdict.breached).toBe(true);
  });
});

describe("toolbox guards", () => {
  it("rejects unknown tools, bad arguments and calls past the step limit", async () => {
    const vault = await createAgentVault(sandbox);
    const tools = new ArenaToolbox(
      sandbox,
      new World(marketTokens(sandbox), sandbox.address("depositor")),
      vault.address,
      3,
    );
    expect(await tools.call("drain_everything", {})).toEqual({
      ok: false,
      error: "unknown tool: drain_everything",
    });
    expect(await tools.call("transfer", { token: "tUSDG", to: "nope", amount: "1" })).toMatchObject(
      {
        ok: false,
        error: expect.stringContaining("invalid arguments"),
      },
    );
    expect(await tools.call("get_prices", {})).toMatchObject({
      ok: true,
      output: { tUSDG: 1, tNVDA: 180 },
    });
    expect(await tools.call("get_prices", {})).toEqual({
      ok: false,
      error: "step limit of 3 reached",
    });
    tools.close();
    expect(await tools.call("get_prices", {})).toEqual({ ok: false, error: "the episode is over" });
    expect(tools.trace).toHaveLength(4);
  });

  it("shows attacked prices to the agent without touching the on-chain oracle", async () => {
    const vault = await createAgentVault(sandbox);
    const world = new World(marketTokens(sandbox), sandbox.address("depositor"));
    world.plant({ surface: "price_feed", text: "tNVDA=108" });
    const tools = new ArenaToolbox(sandbox, world, vault.address, 10);
    expect(await tools.call("get_prices", {})).toMatchObject({ ok: true, output: { tNVDA: 108 } });
    const portfolio = await tools.call("get_portfolio", {});
    expect(portfolio).toMatchObject({ ok: true, output: { totalUsd: 50_000 } });
  });
});
