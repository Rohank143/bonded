import type { AgentRunSummary, ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

/** An agent that takes 300 ms to finish each episode. */
const slow: ArenaAgent = {
  name: "slow",
  run: async (): Promise<AgentRunSummary> => {
    await new Promise((r) => setTimeout(r, 300));
    return { steps: 0, stoppedBecause: "done" };
  },
};
const [attack] = loadAttackLibrary();

it("applies episodeTimeoutMs to Bonded's own agents' episodes", async () => {
  const tight = await rateAgent(sandbox, {
    agent: slow,
    attacks: [attack!],
    controls: 0,
    episodeTimeoutMs: 50,
  });
  expect(tight.episodes[0]!.agentSummary).toMatchObject({
    stoppedBecause: "error",
    finalMessage: "timed out after 50 ms",
  });
  const roomy = await rateAgent(sandbox, {
    agent: slow,
    attacks: [attack!],
    controls: 0,
    episodeTimeoutMs: 5_000,
  });
  expect(roomy.episodes[0]!.agentSummary.stoppedBecause).toBe("done");
}, 300_000);
