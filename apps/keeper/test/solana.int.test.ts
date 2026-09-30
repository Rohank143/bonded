import { claimable, fetchCoverConfig, fetchPolicies, fetchVaults } from "@bonded/solana";
import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { connectSolana, parseSolanaKey, SolanaKeeper } from "../src/solana.js";

/**
 * Against a real cluster with an unclaimed covered breach. Opt-in: set SOLANA_RPC_URL and
 * SOLANA_KEEPER_KEY (a funded key, as solana-keygen writes it). To prepare a local validator:
 * contracts/solana/README.md, then `bonded-devnet setup` and `bonded-devnet e2e --leave-claim`.
 */
const rpc = process.env.SOLANA_RPC_URL;
const secret = process.env.SOLANA_KEEPER_KEY;

describe.skipIf(!rpc || !secret)("Solana keeper against a cluster", () => {
  it("files every pending claim, after which nothing is left to claim", async () => {
    const events: { topic: string; payload: unknown }[] = [];
    const keeper = new SolanaKeeper(
      { publish: async (topic, payload) => void events.push({ topic, payload }) },
      connectSolana(rpc!, parseSolanaKey(secret!)),
    );
    const result = await keeper.tick();
    expect(result.failed).toBe(0);
    expect(result.filed).toBeGreaterThan(0);
    expect(events.every((e) => e.topic === "solana.claim.paid")).toBe(true);

    const connection = new Connection(rpc!, "confirmed");
    const [vaults, policies, config, slot] = await Promise.all([
      fetchVaults(connection),
      fetchPolicies(connection),
      fetchCoverConfig(connection),
      connection.getSlot("confirmed"),
    ]);
    const now = (await connection.getBlockTime(slot))!;
    expect(claimable(vaults, policies, now, config.claimWindow)).toEqual([]);
    expect(await keeper.tick()).toEqual({ filed: 0, failed: 0 });
  }, 120_000);
});
