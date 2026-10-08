import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaGateway,
  createAgentVault,
  RemoteAgent,
  type RemoteRunSummary,
  rateAgent,
  runEpisode,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";
import { fakeRunner } from "./fixtures/gateway-client.js";

/**
 * A fork's requests to the live chain's RPC are paced, and what an agent causes is charged to it:
 * a share per episode and an allowance overall, apart from what the rating's own setup and judging
 * use. The "live chain" here is a local sandbox, so the test needs no network.
 */
let live: Sandbox;
let fork: Sandbox;
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

beforeAll(async () => {
  live = await Sandbox.start();
  fork = await Sandbox.start({
    forkUrl: live.rpcUrl,
    forkDeployment: live.deployment,
    forkBudget: { perSecond: 20, burst: 10, perScope: 60, agentTotal: 100, total: 100_000 },
  });
});
afterAll(async () => {
  await fork?.stop();
  await live?.stop();
});

describe("a fork's budget of live-chain requests", () => {
  it("paces requests that reach the live chain", async () => {
    const reader = createPublicClient({ transport: http(fork.rpcUrl, { retryCount: 0 }) });
    const before = fork.forkFetches!;
    const started = Date.now();
    // Balances of fresh addresses aren't cached by the fork: each one is a live request.
    for (let i = 0; i < 30; i++) await reader.getBalance({ address: fresh() });
    const used = fork.forkFetches! - before;
    expect(used).toBeGreaterThanOrEqual(30);
    // Past the burst of 10, at most 20 a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(((used - 10) / 20) * 1000 - 200);
  }, 120_000);

  it("refuses an agent past its share, and never the rating's own setup", async () => {
    // The review's scenario: reads that spend the budget used to make the next episode's setup
    // fail, which the rating service would retry as an infrastructure failure.
    const reader = createPublicClient({ transport: http(fork.rpcUrl, { retryCount: 0 }) });
    const scope = fork.forkScope()!;
    let reads = 0;
    for (let i = 0; i < 200; i++) {
      const ok = await reader.getBalance({ address: fresh() }).then(
        () => true,
        () => false,
      );
      if (!ok) break;
      reads++;
    }
    scope.close();
    expect(scope.exhausted).toBe(true);
    expect(scope.used).toBeLessThanOrEqual(60);
    expect(reads).toBeLessThanOrEqual(60);
    // Setup and funding after the agent's share is spent still work.
    await createAgentVault(fork);
    await fork.fund(fresh());
    // A new episode's share can still be spent, up to what's left of the overall allowance.
    const next = fork.forkScope()!;
    for (let i = 0; i < 200 && !next.exhausted; i++)
      await reader.getBalance({ address: fresh() }).catch(() => {});
    next.close();
    expect(scope.used + next.used).toBeLessThanOrEqual(100);
    await createAgentVault(fork);
  }, 120_000);

  it("tells the rating which episode's agent spent its share, by the time it hears of the episode", async () => {
    const budgeted = await Sandbox.start({
      forkUrl: live.rpcUrl,
      forkDeployment: live.deployment,
      forkBudget: {
        perSecond: 1_000,
        burst: 1_000,
        perScope: 40,
        agentTotal: 10_000,
        total: 100_000,
      },
    });
    const token = "bonded_rt_fork-budget-runner-0001";
    const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens({ [token]: "reader" }) });
    await gateway.listen();
    const runner = await fakeRunner({
      gateway: gateway.url,
      token,
      mode: "chain",
      onEpisode: async (episode, r) => {
        // Reads fresh balances through the episode's RPC until refused.
        for (let i = 0; i < 100; i++) {
          const res = await fetch(episode.endpoints.rpc!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: i,
              method: "eth_getBalance",
              params: [fresh(), "latest"],
            }),
          });
          if (((await res.json()) as { error?: unknown }).error) break;
        }
        await fetch(episode.endpoints.done, { method: "POST" });
        r.send({ type: "episode_done", episodeId: episode.episodeId, exitCode: 0, durationMs: 0 });
      },
    });
    try {
      const agent = new RemoteAgent({
        gateway,
        sandbox: budgeted,
        runner: "reader",
        mode: "chain",
      });
      const first = await runEpisode(budgeted, { agent, attack: null });
      const remote = (first.agentSummary as RemoteRunSummary).remote;
      expect(remote.budgetExhausted).toBe(true);
      expect(remote.forkFetches).toBeLessThanOrEqual(40);
      // The next episode is set up, run and judged as usual.
      const second = await runEpisode(budgeted, { agent, attack: null });
      expect(second.verdict.breached).toBe(false);
      // A rating's onEpisode already sees the flag: the rating service stops the rating there
      // and charges it to the agent (apps/api worker.ts), so it must be set before the hand-over.
      let seen: { budgetExhausted?: boolean; forkFetches?: number } | undefined;
      const stop = new Error("stopped in onEpisode");
      await expect(
        rateAgent(budgeted, {
          agent,
          attacks: [],
          controls: 2,
          shuffle: false,
          onEpisode: (episode) => {
            seen = (episode.agentSummary as RemoteRunSummary).remote;
            throw stop;
          },
        }),
      ).rejects.toBe(stop);
      expect(seen?.budgetExhausted).toBe(true);
      expect(seen?.forkFetches).toBeGreaterThan(0);
    } finally {
      await runner.close();
      await gateway.close();
      await budgeted.stop();
    }
  }, 300_000);
});
