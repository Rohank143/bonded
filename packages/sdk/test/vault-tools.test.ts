import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type BondedVault, bondedVaultTools } from "../src/index.js";
import type { EpisodeToolResult } from "../src/mcp.js";

const VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const USDG = "0x1111111111111111111111111111111111111111";
const TSLA = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const tokens = [
  { symbol: "tUSDG", address: USDG, decimals: 6 },
  { symbol: "tTSLA", address: TSLA, decimals: 18 },
] as const;

/** A vault whose writes confirm, and whose balance reads answer from `balances` in turn. */
function fakeVault(balances: (() => Promise<bigint>)[]) {
  const execute = vi.fn(async () => ({ hashes: [HASH], breaches: [] }));
  const vault = {
    address: VAULT,
    identify: async () => ({ kind: "vault" as const, holder: VAULT }),
    execute,
    publicClient: { readContract: () => balances.shift()!() },
  } as unknown as BondedVault;
  return { vault, execute };
}

/** A call's output, failing the test when the call failed. */
function output(result: EpisodeToolResult): unknown {
  if (!result.ok) throw new Error(`the call failed: ${result.error}`);
  return result.output;
}

const tool = (vault: BondedVault, name: string) =>
  bondedVaultTools({ vault, tokens, guard: false }).find((t) => t.name === name)!;

describe("bondedVaultTools after a confirmed write", () => {
  it("returns a confirmed swap with its transactions when the balance refresh fails, never ok: false", async () => {
    const { vault, execute } = fakeVault([
      async () => 0n,
      async () => {
        throw new Error("rpc timeout");
      },
    ]);
    const result = await tool(vault, "swap").call({
      tokenIn: "tUSDG",
      tokenOut: "tTSLA",
      amountIn: "250",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(output(result)).toEqual({
      sold: "250 tUSDG",
      received: null,
      transactions: [HASH],
      warning:
        "Trade confirmed (see transactions); couldn't read the new balance, so what it received is unknown. Don't repeat the trade: check vault_status.",
    });
  });

  it("still reports what a swap received when the refresh works", async () => {
    const { vault } = fakeVault([async () => 0n, async () => 5n * 10n ** 18n]);
    const result = await tool(vault, "swap").call({
      tokenIn: "tUSDG",
      tokenOut: "tTSLA",
      amountIn: "250",
    });
    expect(output(result)).toMatchObject({ received: "5 tTSLA", transactions: [HASH] });
    expect(output(result)).not.toHaveProperty("warning");
  });

  it("sends nothing when the balance read before a swap fails", async () => {
    const { vault, execute } = fakeVault([
      async () => {
        throw new Error("rpc down");
      },
    ]);
    const result = await tool(vault, "swap").call({
      tokenIn: "tUSDG",
      tokenOut: "tTSLA",
      amountIn: "250",
    });
    expect(result).toMatchObject({ ok: false, error: "rpc down" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["transfer", { token: "tUSDG", to: RECIPIENT, amount: "10" }, { sent: "10 tUSDG" }],
    ["approve", { token: "tUSDG", spender: RECIPIENT, amount: "10" }, { approved: "10 tUSDG" }],
  ] as const)(
    "returns a confirmed %s with its transactions, with no balance read",
    async (name, args, moved) => {
      const { vault } = fakeVault([]);
      const result = await tool(vault, name).call({ ...args });
      expect(result.ok).toBe(true);
      expect(output(result)).toMatchObject({ ...moved, transactions: [HASH] });
    },
  );
});
