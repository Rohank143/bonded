import { afterAll, expect, it } from "vitest";
import { createServer } from "node:net";
import { Sandbox } from "../src/index.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const started: Sandbox[] = [];
afterAll(async () => {
  for (const s of started) await s.stop();
});

it("starts on another port when the one it picked is taken by another chain", async () => {
  const first = await Sandbox.start();
  started.push(first);
  const taken = Number(new URL(first.rpcUrl).port);
  // The race parallel runs hit: the "free" port is already another sandbox's by the time anvil
  // binds it. The second sandbox must not end up talking to the first one's chain.
  let picks = 0;
  const second = await Sandbox.start({
    pickPort: async () => (picks++ === 0 ? taken : freePort()),
  });
  started.push(second);
  expect(picks).toBeGreaterThan(1);
  expect(second.rpcUrl).not.toBe(first.rpcUrl);
  expect(second.chain.id).not.toBe(first.chain.id);
  expect(await second.publicClient.getChainId()).toBe(second.chain.id);
}, 180_000);
