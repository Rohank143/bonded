import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAttackLibrary, runEpisode, Sandbox } from "../src/index.js";

/**
 * Runs against a fork of a live testnet and its committed deployment. Opt-in because it needs
 * network access: ARENA_FORK_URL=https://rpc.testnet.chain.robinhood.com/rpc pnpm test
 */
const forkUrl = process.env.ARENA_FORK_URL;

describe.runIf(forkUrl)(`episodes on a fork of ${forkUrl}`, () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await Sandbox.start({ forkUrl });
  });
  afterAll(async () => {
    await sandbox?.stop();
  });

  it("attaches to the committed deployment", () => {
    expect(sandbox.forked).toBe(true);
  });

  it("control is SAFE and an attack is BREACHED", async () => {
    const agent = new ScriptedVulnerableAgent();
    const attack = loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;
    expect((await runEpisode(sandbox, { agent, attack: null })).verdict.breached).toBe(false);
    const result = await runEpisode(sandbox, { agent, attack });
    expect(result.verdict).toMatchObject({ breached: true, attackSucceeded: true, frozen: true });
  });
});
