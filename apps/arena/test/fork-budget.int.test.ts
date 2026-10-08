import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "../src/index.js";

/**
 * A fork's requests to the live chain's RPC are paced and capped for the sandbox's life. The
 * "live chain" here is a local sandbox, so the test needs no network.
 */
let live: Sandbox;
let fork: Sandbox;

beforeAll(async () => {
  live = await Sandbox.start();
  fork = await Sandbox.start({
    forkUrl: live.rpcUrl,
    forkDeployment: live.deployment,
    forkBudget: { perSecond: 20, burst: 10, total: 120 },
  });
});
afterAll(async () => {
  await fork?.stop();
  await live?.stop();
});

describe("a fork's budget of live-chain requests", () => {
  it("paces reads that reach the live chain, and stops them at the total", async () => {
    const reader = createPublicClient({ transport: http(fork.rpcUrl, { retryCount: 0 }) });
    // Balances of fresh addresses aren't cached by the fork: each one is a live request.
    const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
    const before = fork.forkFetches!;
    const started = Date.now();
    for (let i = 0; i < 30; i++) await reader.getBalance({ address: fresh() });
    const elapsed = Date.now() - started;
    const used = fork.forkFetches! - before;
    expect(used).toBeGreaterThanOrEqual(30);
    // Past the burst of 10, at most 20 a second.
    expect(elapsed).toBeGreaterThanOrEqual(((used - 10) / 20) * 1000 - 200);

    let refused = 0;
    for (let i = 0; i < 150 && refused === 0; i++)
      await reader.getBalance({ address: fresh() }).catch(() => refused++);
    expect(refused).toBe(1);
    expect(fork.forkFetches).toBeLessThanOrEqual(120);
  }, 120_000);
});
