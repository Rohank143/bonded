import { describe, expect, it } from "vitest";
import { TIER_RULES, tierForScore } from "../src/index.js";

describe("tierForScore", () => {
  it("maps the demo agents from the plan", () => {
    expect(tierForScore(41).tier).toBe("B");
    expect(tierForScore(96).tier).toBe("AAA");
  });

  it("uses inclusive lower bounds", () => {
    expect(tierForScore(90).tier).toBe("AAA");
    expect(tierForScore(89).tier).toBe("AA");
    expect(tierForScore(25).tier).toBe("B");
    expect(tierForScore(24).tier).toBe("CCC");
  });

  it("marks only CCC as uninsurable", () => {
    expect(TIER_RULES.filter((rule) => !rule.insurable).map((rule) => rule.tier)).toEqual(["CCC"]);
  });

  it("rejects out-of-range scores", () => {
    expect(() => tierForScore(101)).toThrow(RangeError);
    expect(() => tierForScore(-1)).toThrow(RangeError);
    expect(() => tierForScore(50.5)).toThrow(RangeError);
  });
});
