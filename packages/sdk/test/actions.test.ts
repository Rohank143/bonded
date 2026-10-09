import { mandateVaultAbi } from "@bondedhq/shared";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Log,
  parseUnits,
} from "viem";
import { describe, expect, it } from "vitest";
import { demoRouter, describeAction, erc20Call, normaliseAction } from "../src/actions.js";
import { readExecuteOutcome, toDryRunResult } from "../src/breaches.js";

const VAULT = "0x00000000000000000000000000000000000000AA";
const USDG = "0x1111111111111111111111111111111111111111";
const TSLA = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x4444444444444444444444444444444444444444";
const tokens = [
  { symbol: "tUSDG", address: USDG, decimals: 6 },
  { symbol: "tTSLA", address: TSLA, decimals: 18 },
];

describe("actions", () => {
  it("normalises addresses and rejects bad fields with the field's name", () => {
    expect(
      normaliseAction({
        type: "transfer",
        token: USDG,
        to: VAULT.toLowerCase() as never,
        amount: 1n,
      }),
    ).toEqual({ type: "transfer", token: USDG, to: VAULT, amount: 1n });
    expect(() =>
      normaliseAction({ type: "approve", token: USDG, spender: "0xnope" as never, amount: 1n }),
    ).toThrow(/approve: spender must be an address/);
    expect(() =>
      normaliseAction({ type: "swap", tokenIn: USDG, tokenOut: TSLA, amountIn: 5 as never }),
    ).toThrow(/amountIn must be a non-negative bigint/);
    expect(() => normaliseAction({ type: "call", target: ROUTER, data: "nope" as never })).toThrow(
      /hex/,
    );
    expect(() => normaliseAction({ type: "mint" } as never)).toThrow(/unknown action type/);
  });

  it("encodes ERC-20 transfers and approvals for the vault to make", () => {
    const call = erc20Call("transfer", USDG, VAULT, 5n);
    expect(call.target).toBe(USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toEqual({
      functionName: "transfer",
      args: [VAULT, 5n],
    });
  });

  it("swaps through DemoRouter with the vault as the recipient", () => {
    const data = demoRouter(ROUTER.toLowerCase() as never).encodeSwap({
      tokenIn: USDG,
      tokenOut: TSLA,
      amountIn: 7n,
      minOut: 0n,
      recipient: VAULT,
    });
    expect(data.slice(0, 10)).toBe("0x6e81221c"); // swap(address,address,uint256,address)
    expect(data.toLowerCase()).toContain(VAULT.slice(2).toLowerCase());
  });

  it("describes actions in symbols and whole units for Sentinel, as the Arena's tools do", () => {
    expect(
      describeAction(
        { type: "swap", tokenIn: USDG, tokenOut: TSLA, amountIn: parseUnits("2000", 6) },
        tokens,
      ),
    ).toEqual({ tool: "swap", args: { tokenIn: "tUSDG", tokenOut: "tTSLA", amountIn: "2000" } });
    // Unknown tokens keep their address and base units.
    expect(describeAction({ type: "approve", token: ROUTER, spender: VAULT, amount: 5n })).toEqual({
      tool: "approve",
      args: { token: ROUTER, spender: VAULT, amount: "5" },
    });
  });
});

describe("reading the vault's events", () => {
  const log = (
    eventName: "Executed" | "BreachRecorded" | "Frozen",
    args: never,
    data: `0x${string}`,
    address = VAULT,
  ) =>
    ({
      address,
      topics: encodeEventTopics({ abi: mandateVaultAbi, eventName, args }),
      data,
    }) as unknown as Log;
  const breach = (id: bigint, type: number, blocked: boolean, loss = 0n) =>
    log(
      "BreachRecorded",
      { breachId: id, breachType: type, target: ROUTER } as never,
      encodeAbiParameters(
        [{ type: "bytes4" }, { type: "uint256" }, { type: "bool" }],
        ["0xa9059cbb", loss, blocked],
      ),
    );
  const executed = log(
    "Executed",
    { target: ROUTER, selector: "0xa9059cbb" } as never,
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 0n]),
  );
  const frozen = log("Frozen", { by: VAULT } as never, "0x");

  it("reads an executed action with a breach (Monitor mode)", () => {
    const outcome = readExecuteOutcome(VAULT, [breach(3n, 2, false, 9n), frozen, executed]);
    expect(outcome).toMatchObject({ executed: true, froze: true });
    expect(outcome.breaches).toEqual([
      {
        id: 3n,
        type: "T1_UNAUTHORIZED_TRANSFER",
        reason: expect.stringContaining("recipient"),
        target: ROUTER,
        selector: "0xa9059cbb",
        lossUsd6: 9n,
        blocked: false,
      },
    ]);
    expect(toDryRunResult(outcome)).toMatchObject({ ok: false, blocked: false, wouldFreeze: true });
  });

  it("ignores events from other contracts", () => {
    const foreign = log("Frozen", { by: VAULT } as never, "0x", ROUTER);
    expect(readExecuteOutcome(VAULT, [executed, foreign]).froze).toBe(false);
  });

  it("names the action's own breach, not an earlier deferred one", () => {
    const result = toDryRunResult(
      readExecuteOutcome(VAULT, [breach(0n, 3, false, 5n), breach(1n, 4, true)]),
    );
    expect(result).toMatchObject({ ok: false, executed: false, blocked: true });
    expect(result.breach?.type).toBe("T2_LIMIT");
    expect(result.breaches.map((b) => b.type)).toEqual(["T1_DEFERRED", "T2_LIMIT"]);
  });
});
