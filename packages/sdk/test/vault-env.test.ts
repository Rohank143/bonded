import { episodeEnv } from "@bondedhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BondedError,
  bondedVaultFromEnv,
  bondedVaultTools,
  isBondedEpisode,
} from "../src/index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("bondedVaultFromEnv", () => {
  it("is undefined until BONDED_VAULT_ADDRESS is set, so the same code runs without a vault", () => {
    expect(bondedVaultFromEnv({})).toBeUndefined();
  });

  it("builds a vault on Robinhood Chain testnet by default", async () => {
    const vault = bondedVaultFromEnv({ BONDED_VAULT_ADDRESS: VAULT, BONDED_AGENT_KEY: KEY })!;
    expect(vault.address).toBe(VAULT);
    expect(vault.walletClient?.chain?.id).toBe(46630);
    expect(vault.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("names every missing or malformed variable", () => {
    const error = (() => {
      try {
        bondedVaultFromEnv({
          BONDED_VAULT_ADDRESS: VAULT,
          BONDED_VAULT_CHAIN_ID: "999999",
          BONDED_ROUTER_ADDRESS: "nope",
        });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BondedError);
    expect((error as BondedError).message).toBe(
      "BONDED_AGENT_KEY (the vault's agent key) isn't set; BONDED_VAULT_RPC_URL isn't set (no default RPC for chain 999999); BONDED_ROUTER_ADDRESS isn't an address",
    );
  });

  it("never reads the runner's episode variables", () => {
    expect(
      bondedVaultFromEnv({
        BONDED_VAULT: VAULT,
        BONDED_SESSION_KEY: KEY,
        BONDED_RPC_URL: "http://x",
      }),
    ).toBeUndefined();
  });

  describe("while the process is rated", () => {
    const PRODUCTION = { BONDED_VAULT_ADDRESS: VAULT, BONDED_AGENT_KEY: KEY };
    // A full episode environment, as the runner writes it.
    const EPISODE = episodeEnv({
      type: "episode",
      episodeId: "ep-1",
      task: { goal: "Buy tNVDA.", mandate: "Trade the basket.", maxSteps: 3 },
      mode: "tools",
      endpoints: {
        mcp: "https://gw.example/e/t/mcp",
        tools: "https://gw.example/e/t/tools",
        openapi: "https://gw.example/e/t/openapi.json",
        done: "https://gw.example/e/t/done",
      },
      chainId: 46630,
      vault: "0x00000000000000000000000000000000000000aa",
      contracts: {
        exchange: "0x4444444444444444444444444444444444444444",
        tokens: [
          { symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
        ],
      },
      deadlineMs: 300_000,
    });
    afterEach(() => {
      delete process.env.BONDED_EPISODE_ID;
      vi.restoreAllMocks();
    });

    it("never builds the production vault, even with its variables back (a reloaded .env), and says why once", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(isBondedEpisode(EPISODE)).toBe(true);
      expect(bondedVaultFromEnv({ ...EPISODE, ...PRODUCTION })).toBeUndefined();
      // Fails closed: an episode id alone counts, and so does the process's own environment.
      expect(bondedVaultFromEnv({ BONDED_EPISODE_ID: "ep-1", ...PRODUCTION })).toBeUndefined();
      process.env.BONDED_EPISODE_ID = "ep-1";
      expect(bondedVaultFromEnv(PRODUCTION)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toMatch(
        /running a Bonded episode, so the production vault .* is never used/,
      );
    });

    it("refuses the production vault's tools and writes once the process is rated", async () => {
      const vault = bondedVaultFromEnv(PRODUCTION)!;
      process.env.BONDED_EPISODE_ID = "ep-1";
      expect(() => bondedVaultTools({ vault })).toThrow(/RATED|running a Bonded episode/);
      await expect(vault.transfer({ token: VAULT, to: VAULT, amount: 1n })).rejects.toMatchObject({
        code: "RATED_PRODUCTION_VAULT",
      });
      delete process.env.BONDED_EPISODE_ID;
      // Built before the process was rated, the tools still check at each call.
      const tools = bondedVaultTools({ vault, tokens: [] });
      process.env.BONDED_EPISODE_ID = "ep-1";
      const result = await tools
        .find((t) => t.name === "transfer")!
        .call({
          token: VAULT,
          to: VAULT,
          amount: "1",
        });
      expect(result).toMatchObject({ ok: false });
      expect(result.text).toMatch(/running a Bonded episode/);
    });
  });
});
