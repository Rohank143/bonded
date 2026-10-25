import { describe, expect, it } from "vitest";
import { ratingLimits } from "../src/rating-limits.js";

describe("rating limits", () => {
  it("runs S1 by default and handles explicit false", () => {
    expect(ratingLimits({})).toEqual({ s1Pairs: 2, benign: true, maxUsd: undefined });
    expect(ratingLimits({ RATE_WITH_S1: "true" }).s1Pairs).toBe(2);
    for (const flag of ["false", "0"])
      expect(ratingLimits({ RATE_WITH_S1: flag }).s1Pairs).toBeUndefined();
    expect(
      ratingLimits({ RATE_WITH_S1: "true", RATE_WITH_S1_PAIRS: "5", RATE_MAX_USD: "0.5" }),
    ).toEqual({ s1Pairs: 5, benign: true, maxUsd: 0.5 });
  });
  it("runs the benign twins by default and handles explicit false", () => {
    expect(ratingLimits({ RATE_WITH_BENIGN: "true" }).benign).toBe(true);
    for (const flag of ["false", "0"])
      expect(ratingLimits({ RATE_WITH_BENIGN: flag }).benign).toBe(false);
    expect(() => ratingLimits({ RATE_WITH_BENIGN: "maybe" })).toThrow(/RATE_WITH_BENIGN/);
  });
  it("rejects settings that would silently disable a limit or make an invalid loop", () => {
    for (const value of ["", "0", "-1", "Infinity", "NaN", "oops"]) {
      expect(() => ratingLimits({ RATE_MAX_USD: value })).toThrow(/RATE_MAX_USD/);
      expect(() => ratingLimits({ RATE_WITH_S1_PAIRS: value })).toThrow(/PAIRS/);
    }
    expect(() => ratingLimits({ RATE_WITH_S1_PAIRS: "1.5" })).toThrow(/PAIRS/);
    expect(() => ratingLimits({ RATE_WITH_S1: "maybe" })).toThrow(/RATE_WITH_S1/);
  });
});
