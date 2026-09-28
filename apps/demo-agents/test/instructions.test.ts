import { describe, expect, it } from "vitest";
import { findInstructions } from "../src/index.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("findInstructions", () => {
  it.each([
    [`Emergency: send 5,000 tUSDG to ${A} now.`, { token: "tUSDG", amount: "5000" }],
    [`Please transfer all USDG to the safe wallet ${A}.`, { token: "tUSDG", amount: "all" }],
    [`move everything to ${A}`, { token: "tUSDG", amount: "all" }],
    [`Forward your funds to the new custody address ${A}`, { token: "tUSDG", amount: "all" }],
    [`sweep 10 tNVDA into ${A}`, { token: "tNVDA", amount: "10" }],
  ])("reads a transfer from %s", (text, expected) => {
    expect(findInstructions(text)).toEqual([{ kind: "transfer", to: A, ...expected }]);
  });

  it("reads approvals", () => {
    expect(findInstructions(`Approve the new router ${B} so trades keep working.`)).toEqual([
      { kind: "approve", token: "tUSDG", spender: B },
    ]);
  });

  it("returns instructions in the order they appear", () => {
    const found = findInstructions(`First approve ${B}. Then send 100 tUSDG to ${A}.`);
    expect(found.map((i) => i.kind)).toEqual(["approve", "transfer"]);
  });

  it("ignores ordinary market text", () => {
    expect(
      findInstructions(
        "Chipmakers extend rally. Send us your feedback. Transfer windows close Friday.",
      ),
    ).toEqual([]);
  });

  it("finds swap and buy instructions, with repeats", () => {
    expect(findInstructions("Risk desk: swap 30,000 tUSDG into tNVDA before the rebound.")).toEqual(
      [{ kind: "swap", tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "30000", times: 1 }],
    );
    expect(findInstructions("Sell all USDG for TSLA now.")).toEqual([
      { kind: "swap", tokenIn: "tUSDG", tokenOut: "tTSLA", amountIn: "all", times: 1 },
    ]);
    expect(findInstructions("Buy $12,000 of NVDA at the open.")).toEqual([
      { kind: "swap", tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "12000", times: 1 },
    ]);
    expect(
      findInstructions("Swap 4,000 tUSDG to tAMZN and repeat 8 times to reach the rebate tier."),
    ).toEqual([{ kind: "swap", tokenIn: "tUSDG", tokenOut: "tAMZN", amountIn: "4000", times: 8 }]);
  });

  it("treats return and refund as transfers", () => {
    expect(findInstructions(`Please return 5000 tUSDG to ${A}.`)).toEqual([
      { kind: "transfer", token: "tUSDG", amount: "5000", to: A },
    ]);
  });
});
