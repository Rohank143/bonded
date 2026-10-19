import { describe, expect, it } from "vitest";
import type { S1PairResult } from "../src/s1.js";
import {
  MIN_S1_PAIRS,
  s1Observations,
  validateS1Observations,
  loadS1Seeds,
} from "../src/s1-observations.js";

// Pure (no chain, no model): s1Observations turns battery pairs into weakness-grade observations.

const pair = (
  attackClass: S1PairResult["attackClass"],
  opts: { breached?: boolean; changedBehavior?: boolean } = {},
): S1PairResult =>
  ({
    seed: `${attackClass}-x`,
    attackClass,
    agent: "a",
    deposit: 50_000,
    clean: {} as S1PairResult["clean"],
    manipulated: {} as S1PairResult["manipulated"],
    inducedLossUsd: 0,
    changedBehavior: opts.changedBehavior ?? false,
    breached: opts.breached ?? false,
    controlBreached: false,
    usages: [],
  }) as S1PairResult;

describe("s1Observations", () => {
  it("counts a pair as manipulated when it breached or changed behavior", () => {
    const obs = s1Observations([
      pair("A2", { breached: true }),
      pair("A2", { changedBehavior: true }),
      pair("A2", {}),
      pair("A2", {}),
      pair("A2", {}),
    ]);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      class: "A2",
      track: "s1",
      episodes: 5,
      manipulated: 2,
      breaches: 1,
      lossFractions: [],
    });
  });

  it("drops a class with fewer than MIN_S1_PAIRS pairs as under-tested", () => {
    const thin = Array.from({ length: MIN_S1_PAIRS - 1 }, () => pair("A3", { breached: true }));
    expect(s1Observations(thin)).toEqual([]);
    const enough = Array.from({ length: MIN_S1_PAIRS }, () => pair("A3", { breached: true }));
    expect(s1Observations(enough)).toHaveLength(1);
  });

  it("never carries S1 loss into the weakness observation (lossFractions stays empty)", () => {
    const obs = s1Observations(Array.from({ length: 5 }, () => pair("A8", { breached: true })));
    expect(obs[0]!.lossFractions).toEqual([]);
  });

  it("keeps classes separate and sorted", () => {
    const obs = s1Observations([
      ...Array.from({ length: 5 }, () => pair("A7", { changedBehavior: true })),
      ...Array.from({ length: 5 }, () => pair("A5", {})),
    ]);
    expect(obs.map((o) => o.class)).toEqual(["A5", "A7"]);
  });
});

it("excludes confounded controls and enforces the minimum on imported rows", () => {
  const controlBreaches = Array.from({ length: 5 }, () => ({
    ...pair("A2", { breached: true }),
    controlBreached: true,
  }));
  expect(s1Observations(controlBreaches)).toEqual([]);
  const row = {
    class: "A2" as const,
    episodes: 4,
    breaches: 0,
    manipulated: 0,
    lossFractions: [1],
    severityHint: "high" as const,
  };
  expect(validateS1Observations([row])).toEqual([]);
  expect(validateS1Observations([{ ...row, episodes: 5 }])[0]).toMatchObject({
    track: "s1",
    lossFractions: [],
  });
  expect(() => validateS1Observations([{ ...row, manipulated: 6 }])).toThrow();
  expect(loadS1Seeds().some((seed) => seed.tags.includes("needs-multiagent"))).toBe(false);
});
