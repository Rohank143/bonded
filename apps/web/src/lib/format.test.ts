import { describe, expect, it } from "vitest";
import { ago, bps, duration, parseUsd, short, tierOf, usd, when } from "./format";

describe("usd", () => {
  it("formats 6-decimal amounts with grouping", () => {
    expect(usd(1_234_567_890n)).toBe("1,234.56");
    expect(usd(899_999_311n)).toBe("899.99");
    expect(usd(20_000_000_000n, 0)).toBe("20,000");
    expect(usd(0n)).toBe("0.00");
  });
  it("truncates rather than rounding up, so a balance is never overstated", () => {
    expect(usd(999_999n)).toBe("0.99");
  });
});

describe("parseUsd", () => {
  it("accepts plain and grouped amounts up to 6 decimals", () => {
    expect(parseUsd("1000")).toBe(1_000_000_000n);
    expect(parseUsd("1,000.5")).toBe(1_000_500_000n);
    expect(parseUsd(" 0.000001 ")).toBe(1n);
  });
  it("rejects zero, negatives, junk and too many decimals", () => {
    for (const bad of ["", "0", "-5", "1e3", "abc", "1.0000001", "0x10"])
      expect(parseUsd(bad)).toBeNull();
  });
});

it("formats basis points, short hex and tiers", () => {
  expect(bps(434)).toBe("4.34%");
  expect(short("0x0B2B5b9e914C949C14b41ADC002338877f0AA623")).toBe("0x0B2B…A623");
  expect(tierOf(56, 1n)).toBe("BB");
  expect(tierOf(0, 0n)).toBe("unrated");
});

describe("when", () => {
  it("spells the month out, so day and month can't be swapped", () => {
    expect(when(1_793_634_921, "en-GB")).toMatch(/^\d{1,2} Nov 2026, \d\d:\d\d$/);
    expect(when(0)).toBe("never");
  });
});

describe("duration", () => {
  it("uses the largest whole unit", () => {
    expect(duration(604_800)).toBe("7 days");
    expect(duration(86_400n)).toBe("1 day");
    expect(duration(7_200)).toBe("2 hours");
    expect(duration(5_400)).toBe("90 minutes");
    expect(duration(45)).toBe("45 seconds");
    expect(duration(0)).toBe("0 minutes");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-10-07T15:00:00Z");
  it("says how long ago, briefly, and the date after a week", () => {
    expect(ago("2026-10-07T14:59:55Z", now)).toBe("just now");
    expect(ago("2026-10-07T14:59:15Z", now)).toBe("45s ago");
    expect(ago("2026-10-07T14:57:00Z", now)).toBe("3m ago");
    expect(ago("2026-10-07T13:00:00Z", now)).toBe("2h ago");
    expect(ago("2026-10-03T15:00:00Z", now)).toBe("4d ago");
    expect(ago("2026-09-01T15:00:00Z", now, "en-GB")).toBe("1 Sept 2026");
    expect(ago("not a date", now)).toBe("");
    // A clock slightly behind the server's never says "in the future".
    expect(ago("2026-10-07T15:00:05Z", now)).toBe("just now");
  });
});
