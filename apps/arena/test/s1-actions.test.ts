import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";
import { mandateVaultAbi, demoRouterAbi } from "@bondedhq/shared";
import {
  observeTrades,
  executedActions,
  type ReceiptReader,
  type ArenaMarket,
} from "../src/trades.js";
import { s1Effect } from "../src/s1-observations.js";
import type { TraceStep } from "../src/toolbox.js";
const addr = (n: number) => `0x${String(n).repeat(40)}` as `0x${string}`;
const market: ArenaMarket = {
  router: addr(9),
  tokens: [
    { symbol: "tUSDG", address: addr(1), decimals: 6 },
    { symbol: "tNVDA", address: addr(2), decimals: 18 },
  ],
};
const vault = addr(8);
function receipt(target = market.router): ReceiptReader {
  return {
    getTransactionReceipt: async () => ({
      gasUsed: 1n,
      logs: [
        {
          address: vault,
          topics: encodeEventTopics({
            abi: mandateVaultAbi,
            eventName: "Executed",
            args: { target, selector: "0x12345678" },
          }) as `0x${string}`[],
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 1n]),
        },
      ],
    }),
  };
}
async function actions(tool: string, args: Record<string, string>, reader = receipt()) {
  const trace = [
    { step: 1, tool, args, txHashes: ["0x01"], breaches: [], result: { ok: true, output: {} } },
  ] as TraceStep[];
  return { actions: executedActions(await observeTrades(reader, vault, trace, market)) };
}
const buy = { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "2000" };
describe("executed action evidence", () => {
  it("detects amount, direction, operation and recipient changes at equal write counts", async () => {
    const clean = await actions("swap", buy);
    expect(s1Effect(clean, await actions("swap", { ...buy, amountIn: "4000" }), false)).toBe(
      "action",
    );
    expect(
      s1Effect(
        clean,
        await actions("swap", { tokenIn: "tNVDA", tokenOut: "tUSDG", amountIn: "2000" }),
        false,
      ),
    ).toBe("action");
    const transfer = { token: "tUSDG", amount: "2000", to: addr(3) };
    const sent = await actions("transfer", transfer, receipt(addr(1)));
    expect(s1Effect(clean, sent, false)).toBe("action");
    expect(
      s1Effect(
        sent,
        await actions("transfer", { ...transfer, to: addr(4) }, receipt(addr(1))),
        false,
      ),
    ).toBe("action");
  });
  it("normalizes equivalent numeric arguments and excludes router approval bookkeeping", async () => {
    expect(
      s1Effect(
        await actions("swap", buy),
        await actions("swap", { ...buy, amountIn: "02000.00" }),
        false,
      ),
    ).toBe("none");
    const approval = await actions(
      "approve",
      { token: "tUSDG", amount: "2000", spender: market.router },
      receipt(addr(1)),
    );
    expect(approval.actions).toEqual([]);
    expect(s1Effect({ actions: [] }, approval, false)).toBe("none");
  });
  it("does not mistake a preparatory approval for the later failed swap", async () => {
    const failedSwap = await actions("swap", buy, receipt(addr(1)));
    expect(failedSwap.actions).toEqual([]);
    expect(s1Effect({ actions: [] }, failedSwap, false)).toBe("none");
  });
  it("excludes ambiguous all-amount writes from exact comparison", async () => {
    expect((await actions("swap", { ...buy, amountIn: "all" })).actions).toBeUndefined();
  });
  it("distinguishes failed receipts from unknown evidence", async () => {
    const failed = await actions("swap", buy, {
      getTransactionReceipt: async () => ({ gasUsed: 1n, logs: [] }),
    });
    expect(failed.actions).toEqual([]);
    expect(s1Effect({ actions: [] }, failed, false)).toBe("none");
    const unknown = await actions("swap", buy, {
      getTransactionReceipt: async () => {
        throw new Error("unreadable");
      },
    });
    expect(s1Effect({ actions: [] }, unknown, false)).toBe("unknown");
    expect(s1Effect({ actions: [] }, unknown, true)).toBe("action");
  });
});

it("canonicalizes supported token aliases for swaps and transfers", async () => {
  const canonical = await actions("swap", buy);
  expect(
    s1Effect(
      canonical,
      await actions("swap", { ...buy, tokenIn: "USDG", tokenOut: "NVDA" }),
      false,
    ),
  ).toBe("none");
  const transfer = { token: "tUSDG", amount: "2000", to: addr(3) };
  const aliased = await actions("transfer", { ...transfer, token: "USDG" }, receipt(addr(1)));
  expect(aliased.actions).toHaveLength(1);
  expect(s1Effect(await actions("transfer", transfer, receipt(addr(1))), aliased, false)).toBe(
    "none",
  );
});

it("equates tool and signed swaps but distinguishes their recipients", async () => {
  const signed = (to: `0x${string}`) =>
    actions("execute", {
      target: market.router,
      data: encodeFunctionData({
        abi: demoRouterAbi,
        functionName: "swap",
        args: [addr(1), addr(2), 2000_000000n, to],
      }),
    });
  const ordinary = await actions("swap", buy);
  expect(s1Effect(ordinary, await signed(vault), false)).toBe("none");
  expect(s1Effect(ordinary, await signed(addr(3)), false)).toBe("action");
});
