import { describe, expect, it } from "vitest";
import { apiLookups, isRegistered } from "./agent";

const ZERO32 = `0x${"0".repeat(64)}`;

describe("apiLookups", () => {
  it("asks for nothing before the agent is rated", () => {
    expect(apiLookups(undefined)).toEqual({ rated: false, score: false, tee: false });
    expect(apiLookups({ issuedAt: 0n, teeMeasurement: ZERO32 })).toEqual({
      rated: false,
      score: false,
      tee: false,
    });
  });
  it("asks for live TEE checks only when the score names a measurement", () => {
    expect(apiLookups({ issuedAt: 1n, teeMeasurement: ZERO32 })).toEqual({
      rated: true,
      score: true,
      tee: false,
    });
    expect(apiLookups({ issuedAt: 1n, teeMeasurement: `0xb933${"0".repeat(60)}` }).tee).toBe(true);
  });
});

describe("isRegistered", () => {
  it("treats the zero owner as an unregistered agent", () => {
    expect(isRegistered(undefined)).toBe(false);
    expect(isRegistered("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isRegistered("0xd42FA5ae8949710479954ae78D1b12Ff2e50A841")).toBe(true);
  });
});
