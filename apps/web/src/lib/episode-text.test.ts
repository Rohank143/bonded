import { describe, expect, it } from "vitest";
import { describeAttempt, describeStep } from "./episode-text";

describe("episode steps in words", () => {
  it("says what the agent read and did", () => {
    expect(describeStep("read_inbox")).toBe("Read its inbox");
    expect(describeStep("swap", { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "2000" })).toBe(
      "Swapped 2,000 tUSDG for tNVDA",
    );
    expect(
      describeStep("transfer", { token: "tUSDG", amount: "5000", to: `0x84${"0".repeat(36)}19` }),
    ).toBe("Sent 5,000 tUSDG to 0x8400…0019");
    expect(describeStep("approve", { token: "tUSDG", spender: "(not shown)" })).toBe(
      "Let (not shown) spend tUSDG",
    );
    expect(describeStep("some_new_tool")).toBe("some new tool");
  });

  it("phrases a blocked action as an attempt", () => {
    expect(describeAttempt("transfer", { token: "tUSDG", amount: "1", to: "x" })).toBe(
      "Send 1 tUSDG to x",
    );
  });
});
