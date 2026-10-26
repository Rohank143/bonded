import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { keepSentinelAwake, sentinelFromEnv, type SentinelService } from "../src/sentinel.js";

// A Sentinel that is asleep for its first `asleepFor` health probes, as Railway answers while
// it wakes one: a bad gateway, then the service's own 200.
let asleepFor = 0;
let probes = 0;
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== "/health") return void response.writeHead(404).end();
    probes++;
    if (asleepFor > 0) {
      asleepFor--;
      return void response.writeHead(502).end();
    }
    response.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it("waits for a sleeping Sentinel to wake, and gives up at its deadline", async () => {
  const sentinel = sentinelFromEnv({ SENTINEL_URL: url })!;
  probes = 0;
  asleepFor = 2;
  expect(await sentinel.wake!(10_000)).toBe(true);
  expect(probes).toBe(3);
  // Awake: one probe, no waiting.
  probes = 0;
  expect(await sentinel.wake!(0)).toBe(true);
  expect(probes).toBe(1);
  // Still asleep at the deadline.
  probes = 0;
  asleepFor = 10;
  expect(await sentinel.wake!(0)).toBe(false);
  expect(probes).toBe(1);
  asleepFor = 0;
}, 20_000);

it("forgets a down health answer once Sentinel wakes", async () => {
  const sentinel = sentinelFromEnv({ SENTINEL_URL: url })!;
  asleepFor = 1;
  expect(await sentinel.health!()).toBe(false);
  expect(await sentinel.wake!(10_000)).toBe(true);
  expect(await sentinel.health!()).toBe(true);
}, 20_000);

it("keeps Sentinel awake for a rating, and refuses to start one it can't wake", async () => {
  let pings = 0;
  let answers = true;
  const fake: SentinelService = {
    model: { name: "fake", usage: undefined, assess: async () => ({ manipulated: 0 }) as never },
    info: { model: "fake", questions: "v3", blockThreshold: 0.7 },
    wake: async () => {
      pings++;
      return answers;
    },
  };
  const release = await keepSentinelAwake(fake, { pingMs: 20 });
  await delay(110);
  release();
  const during = pings;
  expect(during).toBeGreaterThanOrEqual(3);
  await delay(60);
  expect(pings).toBe(during);

  answers = false;
  await expect(keepSentinelAwake(fake, { wakeMs: 0 })).rejects.toThrow(/didn't answer/);
  // A service without wake (tests, local runs) is taken to be awake.
  (await keepSentinelAwake({ model: fake.model, info: fake.info }))();
});
