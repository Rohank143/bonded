import {
  createPartialAgent,
  ScriptedHardenedAgent,
  ScriptedVulnerableAgent,
} from "@bonded/demo-agents";
import type { ArenaAgent, AttackSpec } from "@bonded/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentVaultOptions,
  ArenaGateway,
  BENIGN_GOALS,
  type EpisodeResult,
  loadAttackLibrary,
  RemoteAgent,
  runEpisode,
  Sandbox,
  StaticRunnerTokens,
} from "../../src/index.js";
import { eventually, type FakeRunner, fakeRunner, type Transport } from "./gateway-client.js";

/**
 * Parity: the scripted brains rated through the gateway (over MCP, plain HTTP, or chain mode with
 * their own signed transactions) get the same verdict, episode by episode, as in-process. Each
 * case runs the same attack, goal and mandate both ways in one sandbox and compares what the
 * vault recorded.
 *
 * By default it runs the first seed of every attack class plus a control episode, for each of
 * the three agents (33 cases per transport). ARENA_PARITY=full runs the whole published library.
 */
export const PARITY_FULL = process.env.ARENA_PARITY === "full";

export function paritySeeds(library: AttackSpec[] = loadAttackLibrary()): AttackSpec[] {
  if (PARITY_FULL) return library;
  const firsts = new Map<string, AttackSpec>();
  for (const spec of library) if (!firsts.has(spec.class)) firsts.set(spec.class, spec);
  return [...firsts.values()];
}

type AgentName = "vulnerable" | "hardened" | "partial";

const AGENTS: Record<
  AgentName,
  { make: () => ArenaAgent; vault: (sandbox: Sandbox) => AgentVaultOptions | undefined }
> = {
  // The demo pair (as in the rating tests) and Agent A, whose mandate allows refunds.
  vulnerable: { make: () => new ScriptedVulnerableAgent(), vault: () => undefined },
  hardened: {
    make: () => new ScriptedHardenedAgent(),
    vault: () => ({ mandate: { mode: "enforce" } }),
  },
  partial: {
    make: () => createPartialAgent("scripted"),
    vault: (sandbox) => ({ mandate: { destinations: [sandbox.address("depositor")] } }),
  },
};

/** What must match: the vault's verdict, breach by breach. */
export function verdictOf(result: EpisodeResult) {
  const v = result.verdict;
  return {
    breached: v.breached,
    attackSucceeded: v.attackSucceeded,
    frozen: v.frozen,
    breaches: v.breaches.map((b) => `${b.type}${b.blocked ? " (blocked)" : ""}`),
    totalLossUsd: v.totalLossUsd,
    drained: result.drained,
    stoppedBecause: result.agentSummary.stoppedBecause,
  };
}

/** The reads the agent made, in order. */
const readsOf = (result: EpisodeResult) =>
  result.trace.filter((s) => !["swap", "transfer", "approve", "execute"].includes(s.tool));

export function defineParitySuite(transport: Transport): void {
  const mode = transport === "chain" ? "chain" : "tools";
  const token = `parity-runner-token-${transport}`;
  let sandbox: Sandbox;
  let gateway: ArenaGateway;
  let runner: FakeRunner;
  let remote: RemoteAgent;
  /** The brain the stand-in runner runs for the next episode. */
  let brain: ArenaAgent = new ScriptedVulnerableAgent();

  beforeAll(async () => {
    sandbox = await Sandbox.start();
    gateway = new ArenaGateway({ tokens: new StaticRunnerTokens({ [token]: "parity" }) });
    const url = await gateway.listen();
    runner = await fakeRunner({
      gateway: url,
      token,
      mode,
      transport,
      agent: { name: "parity", run: (task, tools) => brain.run(task, tools) },
    });
    await eventually(() => gateway.runner("parity") !== undefined);
    remote = new RemoteAgent({ gateway, sandbox, runner: "parity", mode });
  });
  afterAll(async () => {
    await runner?.close();
    await gateway?.close();
    await sandbox?.stop();
  });

  const seeds = paritySeeds();
  const cases = (Object.keys(AGENTS) as AgentName[]).flatMap((agent) =>
    [...seeds, null].map((attack, i) => ({
      name: `${agent}: ${attack?.id ?? "control"}`,
      agent,
      attack,
      goal: attack?.goal ?? BENIGN_GOALS[i % BENIGN_GOALS.length]!,
    })),
  );

  describe(`verdict parity over ${transport} (${PARITY_FULL ? "full library" : "one seed per class"})`, () => {
    it.each(cases)("$name", async ({ agent, attack, goal }) => {
      const vault = AGENTS[agent].vault(sandbox);
      const options = { attack, goal, ...(vault ? { vault } : {}) };
      const local = await runEpisode(sandbox, { agent: AGENTS[agent].make(), ...options });
      brain = AGENTS[agent].make();
      const through = await runEpisode(sandbox, { agent: remote, ...options });
      expect(verdictOf(through)).toEqual(verdictOf(local));
      if (transport === "chain") {
        // Reads are the same calls in the same order. Writes are the agent's own transactions,
        // and each is a step: a swap that needs an approval is two, so the step cap can stop a
        // late read sooner than in-process. That is the only difference allowed.
        const [mine, theirs] = [readsOf(through), readsOf(local)];
        expect(mine.map((s) => s.tool)).toEqual(theirs.map((s) => s.tool));
        mine.forEach((step, i) => {
          if (step.result.ok !== theirs[i]!.result.ok)
            expect(step.result).toEqual({ ok: false, error: "step limit of 20 reached" });
        });
      } else {
        // Every call, in order. (Arguments can name the episode's fresh attacker address.)
        expect(through.trace.map((s) => [s.tool, s.result.ok])).toEqual(
          local.trace.map((s) => [s.tool, s.result.ok]),
        );
      }
    });
  });
}
