import { CLASS_GROUPS, type ClassGroup } from "./actuarial.js";

/**
 * Observed breach rates in production (docs/SPECIFICATION.md Section 9.1, "λ ... is updated from
 * telemetry across the insured book"). The Arena measures b, the chance an agent breaches when it
 * meets an attack; λ, how often agents meet attacks in a year, is a published prior. Production
 * breaches recorded by vaults are the evidence that can replace the prior, and this module turns
 * them into rates with their counts and exposure, so every number travels with its sample size.
 *
 * The method is actual against expected:
 *
 * - exposure: the agent-years during which rated agents held a valid score;
 * - expected breaches in group g: Σ over that exposure of λ_g · b̄_g · years, where b̄_g is the
 *   posterior mean breach rate from the agent's own rating, (k + 1) ÷ (n + 2);
 * - observed breaches: the vault's breach log over the same exposure;
 * - implied λ_g = prior λ_g · observed ÷ expected.
 *
 * A vault's breach record says which rule was broken, not which attack caused it, so most
 * production breaches can't be put in a group. Those are counted as unattributed: they inform the
 * book-wide ratio, never a group's λ. Pricing keeps the published priors until a group passes
 * `OBSERVED_RATES_THRESHOLD` (see `pricingLambdas`).
 */

/**
 * When an observed λ may replace a group's prior: at least this much exposure, and at least this
 * many breaches attributed to the group. Ten events gives a 90% interval of roughly ±50% on a
 * Poisson rate, which is about as wide as the gap between the priors themselves; below that, the
 * prior is the better estimate. Both numbers are judgement, written here so they can be reviewed.
 */
export const OBSERVED_RATES_THRESHOLD = { minAgentYears: 25, minBreaches: 10 } as const;

const YEAR_SECONDS = 365.25 * 86_400;

/** One rated period of an agent: from a score's issue to its expiry or its replacement. */
export interface ExposurePeriod {
  agentId: string;
  /** Unix seconds. */
  from: number;
  /** Unix seconds; the score's expiry. */
  to: number;
  /** The rating's per-group episodes and breaches (`Scoring.groups`), by group id. */
  groups: Record<string, { episodes: number; breaches: number }>;
}

/** One breach a production vault recorded. */
export interface ProductionBreach {
  agentId: string;
  /** Unix seconds. */
  at: number;
  /** The vault blocked it (Enforce mode). It still counts: the agent tried. */
  blocked: boolean;
  /** The attack group, when something attributes the breach to one (rare: see the module note). */
  group?: string;
}

export interface GroupObservedRate {
  id: string;
  name: string;
  /** The published prior (`CLASS_GROUPS`). */
  priorLambda: number;
  /** Breaches attributed to this group within exposure. */
  breaches: number;
  /** What the priors and the agents' own ratings predict over the same exposure. */
  expectedBreaches: number;
  /** Attributed breaches per agent-year (0 with no exposure). */
  ratePerAgentYear: number;
  /** 90% upper bound on that rate (Poisson); null with no exposure. */
  rateUpper90: number | null;
  /** prior × observed ÷ expected; null when nothing is expected. */
  impliedLambda: number | null;
  /** What pricing uses: the prior, until this group passes the threshold. */
  pricingLambda: number;
  usingObserved: boolean;
}

export interface ObservedRates {
  exposure: { agentYears: number; agents: number; periods: number };
  breaches: {
    /** Every breach given, in exposure or not. */
    total: number;
    /** Breaches while the agent held a valid score: the ones these rates use. */
    inExposure: number;
    /** Breaches by agents without a valid score at the time: not used. */
    outsideExposure: number;
    blocked: number;
    attributed: number;
    unattributed: number;
  };
  /** The whole book: every in-exposure breach against every group's expected breaches. */
  overall: {
    breaches: number;
    expectedBreaches: number;
    /** observed ÷ expected; null when nothing is expected. */
    actualToExpected: number | null;
    ratePerAgentYear: number;
    rateUpper90: number | null;
  };
  groups: GroupObservedRate[];
  threshold: typeof OBSERVED_RATES_THRESHOLD;
  /** True when any group's pricing λ comes from observation. */
  usingObserved: boolean;
}

/**
 * Estimates observed breach rates from rated exposure and production breaches. Overlapping
 * periods of one agent are cut where the newer score starts, so time is never counted twice.
 * Periods and breaches after `now` are ignored.
 */
export function estimateObservedRates(input: {
  periods: readonly ExposurePeriod[];
  breaches: readonly ProductionBreach[];
  /** Unix seconds. */
  now: number;
  groups?: readonly ClassGroup[];
  threshold?: typeof OBSERVED_RATES_THRESHOLD;
}): ObservedRates {
  const groups = input.groups ?? CLASS_GROUPS;
  const threshold = input.threshold ?? OBSERVED_RATES_THRESHOLD;
  const byAgent = new Map<string, ExposurePeriod[]>();
  for (const p of input.periods) {
    const list = byAgent.get(p.agentId) ?? [];
    list.push(p);
    byAgent.set(p.agentId, list);
  }
  // Each agent's periods, in order, each ending where the next starts (a newer score replaces
  // the older one) and none past now.
  const periods: ExposurePeriod[] = [];
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.from - b.from);
    list.forEach((p, i) => {
      const next = list[i + 1];
      const to = Math.min(p.to, next ? next.from : Infinity, input.now);
      if (to > p.from) periods.push({ ...p, to });
    });
  }
  const years = (p: ExposurePeriod) => (p.to - p.from) / YEAR_SECONDS;
  const agentYears = sum(periods.map(years));
  const expected = new Map(
    groups.map((g) => [
      g.id,
      sum(
        periods.map((p) => {
          const r = p.groups[g.id] ?? { episodes: 0, breaches: 0 };
          return g.lambda * ((r.breaches + 1) / (r.episodes + 2)) * years(p);
        }),
      ),
    ]),
  );
  const covered = (b: ProductionBreach) =>
    b.at <= input.now &&
    periods.some((p) => p.agentId === b.agentId && b.at >= p.from && b.at < p.to);
  const counted = input.breaches.filter(covered);
  const known = new Set(groups.map((g) => g.id));
  const attributed = counted.filter((b) => b.group !== undefined && known.has(b.group));

  const rows = groups.map((g): GroupObservedRate => {
    const breaches = attributed.filter((b) => b.group === g.id).length;
    const exp = expected.get(g.id) ?? 0;
    const impliedLambda = exp > 0 ? (g.lambda * breaches) / exp : null;
    const usingObserved =
      impliedLambda !== null &&
      agentYears >= threshold.minAgentYears &&
      breaches >= threshold.minBreaches;
    return {
      id: g.id,
      name: g.name,
      priorLambda: g.lambda,
      breaches,
      expectedBreaches: exp,
      ratePerAgentYear: agentYears > 0 ? breaches / agentYears : 0,
      rateUpper90: agentYears > 0 ? poissonUpperBound(breaches) / agentYears : null,
      impliedLambda,
      pricingLambda: usingObserved ? impliedLambda! : g.lambda,
      usingObserved,
    };
  });
  const expectedTotal = sum([...expected.values()]);
  return {
    exposure: {
      agentYears,
      agents: new Set(periods.map((p) => p.agentId)).size,
      periods: periods.length,
    },
    breaches: {
      total: input.breaches.length,
      inExposure: counted.length,
      outsideExposure: input.breaches.length - counted.length,
      blocked: counted.filter((b) => b.blocked).length,
      attributed: attributed.length,
      unattributed: counted.length - attributed.length,
    },
    overall: {
      breaches: counted.length,
      expectedBreaches: expectedTotal,
      actualToExpected: expectedTotal > 0 ? counted.length / expectedTotal : null,
      ratePerAgentYear: agentYears > 0 ? counted.length / agentYears : 0,
      rateUpper90: agentYears > 0 ? poissonUpperBound(counted.length) / agentYears : null,
    },
    groups: rows,
    threshold,
    usingObserved: rows.some((r) => r.usingObserved),
  };
}

/** The λ each group's pricing uses: the published prior unless observation passed the threshold. */
export function pricingLambdas(rates: ObservedRates): Record<string, number> {
  return Object.fromEntries(rates.groups.map((g) => [g.id, g.pricingLambda]));
}

/**
 * Upper bound on a Poisson mean after observing k events: the μ at which P(X ≤ k) = 1 − level.
 * Solved by bisection on the exact CDF.
 */
export function poissonUpperBound(k: number, level = 0.9): number {
  if (!Number.isInteger(k) || k < 0) throw new RangeError(`need an integer k >= 0, got ${k}`);
  if (!(level > 0 && level < 1)) throw new RangeError(`level must be in (0, 1), got ${level}`);
  let lo = 0;
  let hi = Math.max(10, 4 * (k + 1));
  while (poissonCdf(k, hi) > 1 - level) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (poissonCdf(k, mid) > 1 - level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(X ≤ k) for X ~ Poisson(mu), summed in log space so a large mu doesn't underflow. */
function poissonCdf(k: number, mu: number): number {
  if (mu <= 0) return 1;
  let logTerm = -mu;
  let total = Math.exp(logTerm);
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log(mu) - Math.log(i);
    total += Math.exp(logTerm);
  }
  return Math.min(1, total);
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
