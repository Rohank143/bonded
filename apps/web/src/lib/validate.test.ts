import { describe, expect, it } from "vitest";
import {
  addressError,
  amountOrZeroError,
  dailyLimitError,
  descriptionError,
  limitError,
  positiveAmountError,
} from "./validate";

describe("field checks", () => {
  it("limits are positive whole dollars, and the daily one covers a trade", () => {
    expect(limitError("5000")).toBeNull();
    expect(limitError("")).toMatch(/Enter a limit/);
    expect(limitError("5,000")).toMatch(/Whole dollars/);
    expect(limitError("5000.5")).toMatch(/Whole dollars/);
    expect(limitError("0")).toMatch(/more than 0/);
    expect(dailyLimitError("25000", "5000")).toBeNull();
    expect(dailyLimitError("1000", "5000")).toMatch(/at least the per-trade/);
    // A broken per-trade limit is its own field's problem, not the daily one's.
    expect(dailyLimitError("1000", "abc")).toBeNull();
  });

  it("addresses, with an optional field allowed to stay empty", () => {
    expect(addressError(`0x${"ab".repeat(20)}`)).toBeNull();
    expect(addressError("0x123")).toMatch(/Not an address/);
    expect(addressError("", true)).toBeNull();
    expect(addressError("")).toMatch(/Enter an address/);
  });

  it("descriptions are 1 to 1,000 characters", () => {
    expect(descriptionError("An agent.")).toBeNull();
    expect(descriptionError("  ")).toMatch(/short description/);
    expect(descriptionError("x".repeat(1001))).toMatch(/this is 1001/);
  });

  it("amounts: the bond and deposit may be 0; cover and breaches must be positive", () => {
    expect(amountOrZeroError("0")).toBeNull();
    expect(amountOrZeroError("4000.123456")).toBeNull();
    expect(amountOrZeroError("4000.1234567")).toMatch(/6 decimals/);
    expect(positiveAmountError("")).toBeNull();
    expect(positiveAmountError("0")).toMatch(/positive/);
    const cap = { value: 20_000_000_000n, message: "Capped at 20,000." };
    expect(positiveAmountError("20000", cap)).toBeNull();
    expect(positiveAmountError("20000.01", cap)).toBe("Capped at 20,000.");
  });
});
