import { afterEach, expect, it, vi } from "vitest";
import type { RatingOptions } from "../src/rate.js";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(async () => ({
    report: {
      scoring: {
        score: 100,
        tier: "A",
        expectedLoss: 0,
        premiumRate: 0,
        insurable: true,
        groups: [],
      },
    },
    posted: { posted: false, reason: "test" },
    files: {},
  })),
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  loadEnv: vi.fn(),
}));
vi.mock("../src/rate.js", async (original) => ({
  ...(await original<typeof import("../src/rate.js")>()),
  rateAgent: mocks.rate,
}));
vi.mock("../src/sandbox.js", async (original) => ({
  ...(await original<typeof import("../src/sandbox.js")>()),
  Sandbox: { start: mocks.start },
}));
vi.mock("../src/env.js", async (original) => ({
  ...(await original<typeof import("../src/env.js")>()),
  loadDotEnv: mocks.loadEnv,
}));

const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function runCli(...flags: string[]) {
  vi.resetModules();
  mocks.start.mockResolvedValue({ stop: mocks.stop });
  process.argv = ["node", "arena", "rate", ...flags];
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../src/cli.js");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  return { exit, error };
}

function ratingOptions(): RatingOptions {
  return (mocks.rate.mock.calls as unknown as [unknown, RatingOptions][])[0]![1];
}

it("passes a local timeout and the default S1 battery to the actual rating dispatch", async () => {
  const { exit } = await runCli("--episode-timeout", "1");
  expect(exit).toHaveBeenCalledWith(0);
  expect(ratingOptions()).toMatchObject({ episodeTimeoutMs: 1000, s1: { pairs: 2 } });
  expect(ratingOptions().s1?.seeds.length).toBeGreaterThan(0);
  expect(ratingOptions().memory).toBeUndefined();
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("keeps the five-minute built-in default and honors --no-s1", async () => {
  const { exit } = await runCli("--no-s1");
  expect(exit).toHaveBeenCalledWith(0);
  // Omitting the option preserves runEpisode's five-minute default.
  expect(ratingOptions().episodeTimeoutMs).toBeUndefined();
  expect(ratingOptions().s1).toBeUndefined();
});

it("constructs memory-bot, loads its model credentials, and enables the memory battery", async () => {
  vi.stubEnv("LLM_API_KEY", "test-key");
  const { exit } = await runCli("--agent", "memory-bot", "--model", "test/model", "--no-s1");
  expect(exit).toHaveBeenCalledWith(0);
  expect(mocks.loadEnv).toHaveBeenCalledOnce();
  expect(ratingOptions().agent.name).toBe("memory-bot+no-mandate/test/model");
  expect(ratingOptions().memory?.rounds).toBe(1);
  expect(ratingOptions().memory?.seeds.length).toBeGreaterThan(0);
});

it("rejects remote S1 before starting a sandbox or gateway", async () => {
  const { exit, error } = await runCli("--agent", "remote", "--s1-pairs", "2");
  expect(exit).toHaveBeenCalledWith(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("remote ratings currently run S2 only"),
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
});
