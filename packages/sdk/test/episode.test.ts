import { describe, expect, it } from "vitest";
import { BondedError, fromBondedEnv } from "../src/index.js";

const VAULT = "0x00000000000000000000000000000000000000aa";
const KEY = `0x${"11".repeat(32)}`;
const task = {
  goal: "Buy 2,000 tUSDG of tNVDA.",
  mandate: "You manage a vault holding tUSDG, tNVDA.",
  maxSteps: 12,
};
const contracts = {
  exchange: "0x4444444444444444444444444444444444444444",
  tokens: [{ symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 }],
};
const base = {
  BONDED_EPISODE_ID: "ep-1",
  BONDED_TASK: JSON.stringify(task),
  BONDED_MODE: "tools",
  BONDED_MCP_URL: "https://gw.example/e/tok/mcp",
  BONDED_TOOLS_URL: "https://gw.example/e/tok/tools",
  BONDED_OPENAPI_URL: "https://gw.example/e/tok/openapi.json",
  BONDED_DONE_URL: "https://gw.example/e/tok/done",
  BONDED_VAULT: VAULT,
  BONDED_CHAIN_ID: "46630",
  BONDED_DEADLINE_MS: "300000",
  BONDED_CONTRACTS: JSON.stringify(contracts),
};

describe("fromBondedEnv", () => {
  it("reads a tools-mode episode", () => {
    expect(fromBondedEnv(base)).toEqual({
      episodeId: "ep-1",
      task,
      mode: "tools",
      endpoints: {
        mcp: base.BONDED_MCP_URL,
        tools: base.BONDED_TOOLS_URL,
        openapi: base.BONDED_OPENAPI_URL,
        done: base.BONDED_DONE_URL,
      },
      vault: "0x00000000000000000000000000000000000000AA",
      chainId: 46630,
      contracts,
      deadlineMs: 300_000,
    });
  });

  it("reads a chain-mode episode with its RPC and session key", () => {
    const episode = fromBondedEnv({
      ...base,
      BONDED_MODE: "chain",
      BONDED_RPC_URL: "https://gw.example/e/tok/rpc",
      BONDED_SESSION_KEY: KEY,
    });
    expect(episode.endpoints.rpc).toBe("https://gw.example/e/tok/rpc");
    expect(episode.sessionKey).toBe(KEY);
  });

  it("names every missing or malformed variable", () => {
    const error = (() => {
      try {
        fromBondedEnv({
          ...base,
          BONDED_TASK: "{",
          BONDED_VAULT: "0x12",
          BONDED_DONE_URL: undefined,
        });
      } catch (e) {
        return e as BondedError;
      }
    })();
    expect(error).toBeInstanceOf(BondedError);
    expect(error?.code).toBe("EPISODE_ENV");
    expect(error?.message).toMatch(/BONDED_TASK must be JSON/);
    expect(error?.message).toMatch(/BONDED_VAULT must be a 0x address/);
    expect(error?.message).toMatch(/BONDED_DONE_URL/);
  });

  it("needs an RPC in chain mode, and a well-formed key when one is given", () => {
    expect(() => fromBondedEnv({ ...base, BONDED_MODE: "chain" })).toThrow(
      /chain mode needs BONDED_RPC_URL/,
    );
    expect(() =>
      fromBondedEnv({
        ...base,
        BONDED_MODE: "chain",
        BONDED_RPC_URL: "http://x.test",
        BONDED_SESSION_KEY: "0x12",
      }),
    ).toThrow(/BONDED_SESSION_KEY/);
  });
});
