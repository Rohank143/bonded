import { ScriptedHardenedAgent } from "@bonded/demo-agents";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadAttackLibrary } from "../src/attacks.js";
import { rateAgent } from "../src/rate.js";
import { loadS1Seeds } from "../src/s1-observations.js";
import { Sandbox } from "../src/sandbox.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

it("never signs a partial inline battery and calls the worker hook for the charged clean arm", async () => {
  const hardened = new ScriptedHardenedAgent();
  let calls = 0;
  const onEpisode = vi.fn();
  const result = await rateAgent(sandbox, {
    agent: {
      name: "budgeted-hardened",
      async run(task, tools) {
        const summary = await hardened.run(task, tools);
        return {
          ...summary,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: ++calls === 1 ? 0.1 : 1 },
        };
      },
    },
    attacks: [loadAttackLibrary()[0]!],
    controls: 0,
    s1: { seeds: [loadS1Seeds()[0]!], pairs: 2 },
    maxUsd: 0.5,
    onEpisode,
  });
  expect(calls).toBe(2);
  expect(onEpisode).toHaveBeenCalledTimes(2);
  expect(onEpisode.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [0, 5],
    [1, 5],
  ]);
  expect(result.report.stoppedEarly).toMatch(/S1 battery/);
  expect(result.report.spend.spentUsd).toBeCloseTo(1.1);
  expect(result.report.s1).toEqual([]);
  expect(result.attestation).toBeNull();
  expect(result.posted.posted).toBe(false);
}, 120_000);
