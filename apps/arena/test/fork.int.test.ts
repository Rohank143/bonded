import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaGateway,
  ArenaToolbox,
  createAgentVault,
  liveClientVersion,
  loadAttackLibrary,
  marketTokens,
  runEpisode,
  Sandbox,
  StaticRunnerTokens,
  World,
} from "../src/index.js";

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

  it("can report a chain id of its own, for keys that must not sign live transactions", async () => {
    const own = await Sandbox.start({ forkUrl, forkChainId: 990_000_001 });
    try {
      expect(own.chain.id).toBe(990_000_001);
      expect(own.liveChainId).toBe(sandbox.chain.id);
      expect(own.deployment.chainId).toBe(sandbox.chain.id);
    } finally {
      await own.stop();
    }
  });

  it("keeps the live chain id and current time, as an agent's own RPC sees them", async () => {
    const live = createPublicClient({ transport: http(forkUrl) });
    expect(sandbox.chain.id).toBe(await live.getChainId());
    const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens() });
    await gateway.listen();
    try {
      const vault = await createAgentVault(sandbox);
      const toolbox = new ArenaToolbox(
        sandbox,
        new World(marketTokens(sandbox), sandbox.address("depositor")),
        vault.address,
        20,
      );
      const episode = gateway.openEpisode({
        episodeId: "fork",
        toolbox,
        mode: "chain",
        chain: {
          upstream: sandbox.rpcUrl,
          chainId: sandbox.chain.id,
          vault: vault.address,
          agent: sandbox.address("agent"),
          clientVersion: await liveClientVersion(forkUrl!),
        },
      });
      const agentView = createPublicClient({ transport: http(episode.endpoints.rpc) });
      expect(await agentView.getChainId()).toBe(await live.getChainId());
      // The node version is the live chain's, not the sandbox's.
      const version = await agentView.request({ method: "web3_clientVersion" });
      expect(version).toBe(await live.request({ method: "web3_clientVersion" }));
      expect(version).not.toMatch(/anvil/i);
      const block = await agentView.getBlock();
      // Block times follow the wall clock, not a frozen fork time.
      expect(Math.abs(Number(block.timestamp) - Date.now() / 1000)).toBeLessThan(600);
      episode.close();
    } finally {
      await gateway.close();
    }
  });

  it("control is SAFE and an attack is BREACHED", async () => {
    const agent = new ScriptedVulnerableAgent();
    const attack = loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;
    expect((await runEpisode(sandbox, { agent, attack: null })).verdict.breached).toBe(false);
    const result = await runEpisode(sandbox, { agent, attack });
    expect(result.verdict).toMatchObject({ breached: true, attackSucceeded: true, frozen: true });
  });
});
