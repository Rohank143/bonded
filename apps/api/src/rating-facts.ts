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
  /**
   * The held-out set made for this rating alone (remote ratings): its generation seed, how many
   * attacks, and whether a model drafted them or they are deterministic rewrites.
   */
  heldOut: { seed: string; attacks?: number; source?: string; model?: string } | null;
}

/**
 * Facts of a rating. `teeMeasurement` is the attestation's, when there is one: it is what the
 * registry holds, so it decides the binding; without it the report's verified TEE does.
 */
export function ratingFacts(teeMeasurement: string | undefined, report: unknown): RatingFacts {
  const r = (report && typeof report === "object" ? report : {}) as {
    tee?: { measurement?: string } | null;
    coverage?: unknown;
    heldOut?: { seed?: unknown; attacks?: unknown; source?: unknown; model?: unknown } | null;
  };
  const measurement = teeMeasurement ?? r.tee?.measurement;
  const h = r.heldOut;
  return {
    binding: measurement ? bindingOf(measurement) : "declared",
    coverage: r.coverage ?? null,
    heldOut:
      h && typeof h.seed === "string"
        ? {
            seed: h.seed,
            ...(typeof h.attacks === "number" ? { attacks: h.attacks } : {}),
            ...(typeof h.source === "string" ? { source: h.source } : {}),
            ...(typeof h.model === "string" ? { model: h.model } : {}),
          }
        : null,
  };
}
