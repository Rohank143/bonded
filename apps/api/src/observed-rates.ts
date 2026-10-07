import type { Hono } from "hono";
import type { Database } from "@bonded/db";
import { CLASS_GROUPS, estimateObservedRates, type ObservedRates } from "@bonded/shared";

/**
 * GET /stats/observed-rates: breaches production vaults recorded, per agent-year of rated
 * exposure, against what the published priors predict (`estimateObservedRates` in
 * @bonded/shared). Every rate comes with its counts and exposure. Pricing keeps the published
 * priors until the documented threshold is met; the response says whether it is.
 */
export function observedRatesRoute(
  app: Hono,
  options: { db: Database; chainId: number; cacheMs?: number; now?: () => number },
) {
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  let cache: { at: number; body: unknown } | undefined;
  app.get("/stats/observed-rates", async (c) => {
    if (cache && now() - cache.at < cacheMs) return c.json(cache.body);
    const inputs = await options.db.observedRateInputs(options.chainId);
    const dated = inputs.breaches.filter(
      (b): b is { agentId: string; at: Date; blocked: boolean | null } =>
        b.agentId !== null && b.at !== null,
    );
    const rates: ObservedRates = estimateObservedRates({
      periods: inputs.periods.map((p) => ({
        ...p,
        groups: Object.fromEntries(
          p.groups.map((g) => [g.id, { episodes: g.episodes, breaches: g.breaches }]),
        ),
      })),
      breaches: dated.map((b) => ({
        agentId: b.agentId,
        at: Math.floor(b.at.getTime() / 1000),
        blocked: b.blocked === true,
      })),
      now: Math.floor(now() / 1000),
    });
    const body = {
      chainId: options.chainId,
      generatedAt: new Date(now()).toISOString(),
      ...rates,
      // Breaches recorded before the keeper kept their agent and time can't be placed in exposure.
      breachesWithoutDetails: inputs.breaches.length - dated.length,
      priors: CLASS_GROUPS.map((g) => ({ id: g.id, name: g.name, lambda: g.lambda })),
      assumptions: [
        "Exposure is the time rated agents held a valid score; a newer score replaces an older one from when it was issued.",
        "Expected breaches use each agent's own rating: λ × the posterior mean breach rate (k + 1) ÷ (n + 2), per group.",
        "A vault records which rule a breach broke, not which attack caused it, so production breaches are unattributed and only inform the book-wide ratio.",
        "Blocked breaches (Enforce mode) count: the agent tried.",
        `Pricing keeps the published priors until a group has ${rates.threshold.minAgentYears} agent-years of exposure and ${rates.threshold.minBreaches} attributed breaches.`,
      ],
    };
    cache = { at: now(), body };
    return c.json(body);
  });
}
