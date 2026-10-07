import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  AttackSurface,
  DoneRequest,
  episodeEnv,
  type EpisodeMessage,
  parseEpisodeEnv,
  parseRunnerMessage,
  RunnerToServer,
  ServerToRunner,
  surfaceTool,
  toolSurface,
} from "../src/index.js";

const episode: EpisodeMessage = {
  type: "episode",
  episodeId: "ep-1",
  task: { goal: "Buy 2000 tUSDG worth of tNVDA.", mandate: "Trade the basket.", maxSteps: 20 },
  mode: "chain",
  endpoints: {
    mcp: "https://gw.example/e/abc/mcp",
    tools: "https://gw.example/e/abc/tools",
    openapi: "https://gw.example/e/abc/openapi.json",
    rpc: "https://gw.example/e/abc/rpc",
    done: "https://gw.example/e/abc/done",
  },
  chainId: 46630,
  vault: "0x000000000000000000000000000000000000dEaD",
  contracts: {
    exchange: "0x000000000000000000000000000000000000bEEF",
    tokens: [
      { symbol: "tUSDG", address: "0x000000000000000000000000000000000000cafE", decimals: 6 },
    ],
  },
  sessionKey: `0x${"11".repeat(32)}`,
  deadlineMs: 60_000,
};

describe("runner protocol", () => {
  it("round-trips every server message through JSON", () => {
    for (const message of [episode, { type: "cancel", episodeId: "ep-1" }, { type: "pong" }]) {
      expect(parseRunnerMessage(ServerToRunner, JSON.stringify(message))).toEqual(message);
    }
  });

  it("round-trips every runner message through JSON", () => {
    const messages = [
      { type: "hello", runnerVersion: "0.1.0", protocol: 1, mode: "tools" },
      { type: "ping", at: 1 },
      { type: "tee_evidence", episodeId: "ep-1", evidence: { quote: "0x00" } },
      { type: "episode_started", episodeId: "ep-1" },
      {
        type: "episode_done",
        episodeId: "ep-1",
        exitCode: 0,
        durationMs: 12,
        stdoutTail: "ok",
      },
    ];
    for (const message of messages) {
      expect(parseRunnerMessage(RunnerToServer, JSON.stringify(message))).toEqual(message);
    }
  });

  it("refuses malformed, unknown and oversized messages instead of half-handling them", () => {
    expect(parseRunnerMessage(RunnerToServer, "not json")).toBeUndefined();
    expect(parseRunnerMessage(RunnerToServer, JSON.stringify({ type: "shell" }))).toBeUndefined();
    expect(
      parseRunnerMessage(ServerToRunner, JSON.stringify({ ...episode, vault: "0xdead" })),
    ).toBeUndefined();
    expect(
      parseRunnerMessage(
        RunnerToServer,
        JSON.stringify({
          type: "episode_done",
          episodeId: "ep-1",
          exitCode: 0,
          durationMs: 1,
          stderrTail: "x".repeat(100_000),
        }),
      ),
    ).toBeUndefined();
    expect(DoneRequest.safeParse({ finalMessage: "x".repeat(5_000) }).success).toBe(false);
  });

  it("gives the agent its episode in the environment, with the key only in chain mode", () => {
    const env = episodeEnv(episode);
    expect(env).toMatchObject({
      BONDED_EPISODE_ID: "ep-1",
      BONDED_MCP_URL: episode.endpoints.mcp,
      BONDED_RPC_URL: episode.endpoints.rpc,
      BONDED_SESSION_KEY: episode.sessionKey,
      BONDED_CHAIN_ID: "46630",
      BONDED_DEADLINE_MS: "60000",
    });
    expect(JSON.parse(env.BONDED_TASK!)).toEqual(episode.task);
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true);
    const tools = episodeEnv({
      ...episode,
      mode: "tools",
      sessionKey: undefined,
      endpoints: { ...episode.endpoints, rpc: undefined },
    });
    expect(tools).not.toHaveProperty("BONDED_SESSION_KEY");
    expect(tools).not.toHaveProperty("BONDED_RPC_URL");
  });
});

describe("the episode environment", () => {
  it("reads back exactly what episodeEnv wrote, addresses checksummed", () => {
    const parsed = parseEpisodeEnv(episodeEnv(episode));
    const rest: Partial<EpisodeMessage> = { ...episode };
    delete rest.type;
    expect(parsed).toEqual({
      ok: true,
      episode: {
        ...rest,
        vault: "0x000000000000000000000000000000000000dEaD",
        contracts: {
          exchange: "0x000000000000000000000000000000000000bEEF",
          tokens: [
            { symbol: "tUSDG", address: "0x000000000000000000000000000000000000cafE", decimals: 6 },
          ],
        },
      },
    });
  });

  it("names every missing or malformed variable", () => {
    const env = episodeEnv(episode);
    const parsed = parseEpisodeEnv({
      ...env,
      BONDED_TASK: "{",
      BONDED_DEADLINE_MS: "soon",
    });
    expect(parsed.ok).toBe(false);
    const problems = (parsed as { problems: string[] }).problems.join("; ");
    expect(problems).toMatch(/BONDED_TASK must be JSON/);
    expect(problems).toMatch(/BONDED_DEADLINE_MS/);
    expect(parseEpisodeEnv({ ...env, BONDED_RPC_URL: undefined })).toEqual({
      ok: false,
      problems: ["BONDED_RPC_URL chain mode needs BONDED_RPC_URL"],
    });
  });
});

describe("tool surfaces", () => {
  it("maps every attack surface to exactly one read tool, and back", () => {
    for (const surface of AttackSurface.options) {
      const tool = surfaceTool(surface);
      expect(AGENT_TOOLS[tool].writes).toBe(false);
      expect(toolSurface(tool)).toBe(surface);
    }
  });

  it("gives writes, chain-only reads and unknown names no surface", () => {
    for (const name of AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].writes))
      expect(toolSurface(name)).toBeUndefined();
    expect(toolSurface("get_portfolio")).toBeUndefined();
    expect(toolSurface("toString")).toBeUndefined();
  });
});
