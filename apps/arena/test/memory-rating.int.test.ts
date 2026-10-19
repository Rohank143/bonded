import { ScriptedHardenedAgent } from "@bonded/demo-agents";
import type { ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadAttackLibrary } from "../src/attacks.js";
import { runMemoryPair, MemoryEpisodeError } from "../src/memory-attempt.js";
import { loadMemorySeeds } from "../src/memory-observations.js";
import { rateAgent } from "../src/rate.js";
import { Sandbox } from "../src/sandbox.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

it.each([false, true])(
  "restores matched chain state and clears notes (failure=%s)",
  async (fail) => {
    const hardened = new ScriptedHardenedAgent();
    const blocks: bigint[] = [];
    const notes: string[] = [];
    const agent = {
      name: "memory-state-test",
      memory: notes,
      reset() {
        notes.length = 0;
      },
      async run(...args: Parameters<ScriptedHardenedAgent["run"]>) {
        blocks.push((await sandbox.publicClient.getBlock({ blockTag: "latest" })).number!);
        notes.push("saved session");
        const result = await hardened.run(...args);
        if (fail && blocks.length === 3) throw new Error("injected failure");
        return result;
      },
    };
    const before = await sandbox.publicClient.getBlock({ blockTag: "latest" });
    const pair = runMemoryPair({ sandbox, agent, seed: loadMemorySeeds()[0]!, round: 0 });
    if (fail) await expect(pair).rejects.toThrow(MemoryEpisodeError);
    else await pair;
    expect(blocks[0]).toBe(blocks[2]);
    if (!fail) expect(blocks[1]).toBe(blocks[3]);
    expect((await sandbox.publicClient.getBlock({ blockTag: "latest" })).hash).toBe(before.hash);
    expect(notes).toEqual([]);
  },
  120_000,
);

it("charges every memory session, persists its hook, and never signs a partial battery", async () => {
  const hardened = new ScriptedHardenedAgent();
  const notes: string[] = [];
  let calls = 0;
  const onEpisode = vi.fn();
  const agent: ArenaAgent & { memory: string[]; reset(): void } = {
    name: "budgeted-memory",
    memory: notes,
    reset() {
      notes.length = 0;
    },
    async run(task, tools) {
      notes.push("saved session");
      return {
        ...(await hardened.run(task, tools)),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: ++calls === 1 ? 0.1 : 1 },
      };
    },
  };
  const result = await rateAgent(sandbox, {
    agent,
    attacks: [loadAttackLibrary()[0]!],
    controls: 0,
    memory: { seeds: [loadMemorySeeds()[0]!], rounds: 1 },
    maxUsd: 0.5,
    onEpisode,
  });
  expect(calls).toBe(2);
  expect(onEpisode.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [0, 5],
    [1, 5],
  ]);
  expect(result.report.stoppedEarly).toMatch(/memory/i);
  expect(result.report.spend.spentUsd).toBeCloseTo(1.1);
  expect(result.attestation).toBeNull();
  expect(notes).toEqual([]);
}, 120_000);
