import { describe, expect, it } from "vitest";
import {
  CLASS_GROUPS,
  estimateObservedRates,
  OBSERVED_RATES_THRESHOLD,
  poissonUpperBound,
  pricingLambdas,
  type ExposurePeriod,
} from "../src/index.js";

const YEAR = 365.25 * 86_400;
const T0 = 1_800_000_000;
// A clean rating: every group ran 10 episodes with no breach, so b̄ = 1/12 in each.
const clean = Object.fromEntries(CLASS_GROUPS.map((g) => [g.id, { episodes: 10, breaches: 0 }]));
const period = (agentId: string, fromYears: number, toYears: number): ExposurePeriod => ({
  agentId,
  from: T0 + fromYears * YEAR,
  to: T0 + toYears * YEAR,
  groups: clean,
});

describe("poissonUpperBound", () => {
  it("matches the textbook 90% bounds", () => {
    // Zero events: -ln(0.1) = 2.3026. One event: 3.8897. Ten events: 15.4066.
    expect(poissonUpperBound(0)).toBeCloseTo(2.3026, 3);
    expect(poissonUpperBound(1)).toBeCloseTo(3.8897, 3);
    expect(poissonUpperBound(10)).toBeCloseTo(15.4066, 3);
  });
  it("doesn't underflow for many events", () => {
    expect(poissonUpperBound(1000)).toBeGreaterThan(1000);
    expect(poissonUpperBound(1000)).toBeLessThan(1100);
  });
});

describe("estimateObservedRates", () => {
  it("measures exposure in agent-years, cutting overlaps where the newer score starts", () => {
    const rates = estimateObservedRates({
      // Agent 1: a score for a year, replaced after half a year by another for a year.
      periods: [period("1", 0, 1), period("1", 0.5, 1.5), period("2", 0, 0.25)],
      breaches: [],
      now: T0 + 2 * YEAR,
    });
    expect(rates.exposure.agentYears).toBeCloseTo(1.75, 9);
    expect(rates.exposure).toMatchObject({ agents: 2, periods: 3 });
  });

  it("stops exposure at now", () => {
    const rates = estimateObservedRates({
      periods: [period("1", 0, 1)],
      breaches: [],
      now: T0 + 0.5 * YEAR,
    });
    expect(rates.exposure.agentYears).toBeCloseTo(0.5, 9);
  });

  it("predicts breaches from each agent's own rating and the priors", () => {
    const rates = estimateObservedRates({
      periods: [period("1", 0, 2)],
      breaches: [],
      now: T0 + 3 * YEAR,
    });
    const injection = rates.groups.find((g) => g.id === "injection")!;
    // λ 0.25 · b̄ 1/12 · 2 years.
    expect(injection.expectedBreaches).toBeCloseTo((0.25 / 12) * 2, 9);
    const lambdas = CLASS_GROUPS.reduce((total, g) => total + g.lambda, 0);
    expect(rates.overall.expectedBreaches).toBeCloseTo((lambdas / 12) * 2, 9);
    expect(rates.overall.actualToExpected).toBe(0);
    expect(rates.overall.rateUpper90).toBeCloseTo(2.3026 / 2, 3);
  });

  it("counts only breaches while the agent held a valid score, and says how many it left out", () => {
    const rates = estimateObservedRates({
      periods: [period("1", 0, 1)],
      breaches: [
        { agentId: "1", at: T0 + 0.1 * YEAR, blocked: false },
        { agentId: "1", at: T0 + 0.2 * YEAR, blocked: true },
        // After the score expired, and an agent never rated.
        { agentId: "1", at: T0 + 1.5 * YEAR, blocked: false },
        { agentId: "9", at: T0 + 0.1 * YEAR, blocked: false },
      ],
      now: T0 + 2 * YEAR,
    });
    expect(rates.breaches).toEqual({
      total: 4,
      inExposure: 2,
      outsideExposure: 2,
      blocked: 1,
      attributed: 0,
      unattributed: 2,
    });
    expect(rates.overall.breaches).toBe(2);
    expect(rates.overall.ratePerAgentYear).toBeCloseTo(2, 9);
    // Unattributed breaches never move a group.
    expect(rates.groups.every((g) => g.breaches === 0)).toBe(true);
  });

  it("keeps the published priors until a group passes the documented threshold", () => {
    const at = (i: number) => T0 + (i / 100) * YEAR;
    const breaches = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        agentId: String(i % 30),
        at: at(i),
        blocked: false,
        group: "lookalike",
      }));
    const book = Array.from({ length: 30 }, (_, i) => period(String(i), 0, 1));
    // 30 agent-years, but only 9 attributed breaches: still the prior.
    const few = estimateObservedRates({ periods: book, breaches: breaches(9), now: T0 + YEAR });
    const lookalike = few.groups.find((g) => g.id === "lookalike")!;
    expect(lookalike.breaches).toBe(9);
    expect(lookalike.impliedLambda).not.toBeNull();
    expect(lookalike.usingObserved).toBe(false);
    expect(pricingLambdas(few).lookalike).toBe(0.2);
    expect(few.usingObserved).toBe(false);
    // Ten breaches over 30 agent-years passes it: λ = prior · observed ÷ expected.
    const enough = estimateObservedRates({ periods: book, breaches: breaches(10), now: T0 + YEAR });
    const g = enough.groups.find((x) => x.id === "lookalike")!;
    expect(g.expectedBreaches).toBeCloseTo((0.2 / 12) * 30, 9);
    expect(g.impliedLambda).toBeCloseTo((0.2 * 10) / ((0.2 / 12) * 30), 9);
    expect(g.usingObserved).toBe(true);
    expect(pricingLambdas(enough).lookalike).toBeCloseTo(g.impliedLambda!, 12);
    expect(pricingLambdas(enough).injection).toBe(0.25);
    // Not enough exposure, whatever the count.
    const short = estimateObservedRates({
      periods: book.slice(0, 20),
      breaches: breaches(40).map((b) => ({ ...b, agentId: String(Number(b.agentId) % 20) })),
      now: T0 + YEAR,
    });
    expect(short.groups.find((x) => x.id === "lookalike")!.usingObserved).toBe(false);
    expect(OBSERVED_RATES_THRESHOLD).toEqual({ minAgentYears: 25, minBreaches: 10 });
  });

  it("reports no rate bounds with no exposure", () => {
    const rates = estimateObservedRates({ periods: [], breaches: [], now: T0 });
    expect(rates.exposure.agentYears).toBe(0);
    expect(rates.overall).toMatchObject({ actualToExpected: null, rateUpper90: null });
    expect(rates.groups[0]).toMatchObject({ impliedLambda: null, rateUpper90: null });
  });
});
