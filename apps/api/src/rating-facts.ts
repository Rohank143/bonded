import { bindingOf, type BindingLevel } from "@bonded/shared";

/**
 * What the API adds to a score or a rating so a reader doesn't have to dig in the report (bring
 * your own agent): how firmly the score is tied to the code that runs, which attack surfaces the
 * agent actually read, and the seed of the held-out set made for this rating.
 */
export interface RatingFacts {
  /** `tee` when the score carries a verified TEE measurement, otherwise `declared`. */
  binding: BindingLevel;
  /** Per-surface attacked and read counts, for reports that record them; null for older ones. */
  coverage: unknown;
  /** The held-out set generated for this rating, when one was (remote ratings). */
  heldOut: { seed: string } | null;
}

/**
 * Facts of a rating. `teeMeasurement` is the attestation's, when there is one: it is what the
 * registry holds, so it decides the binding; without it the report's verified TEE does.
 */
export function ratingFacts(teeMeasurement: string | undefined, report: unknown): RatingFacts {
  const r = (report && typeof report === "object" ? report : {}) as {
    tee?: { measurement?: string } | null;
    coverage?: unknown;
    heldOut?: { seed?: unknown } | null;
  };
  const measurement = teeMeasurement ?? r.tee?.measurement;
  const seed = r.heldOut?.seed;
  return {
    binding: measurement ? bindingOf(measurement) : "declared",
    coverage: r.coverage ?? null,
    heldOut: typeof seed === "string" || typeof seed === "number" ? { seed: String(seed) } : null,
  };
}
