import type { Susceptibility } from "@bondedhq/shared";
import type { LeaderboardRecord } from "./api";

/**
 * How the security grade's batteries are named on the page. The grade is set by its single worst
 * row, and S1 reuses the attack-class numbers, so a class alone ("A8") doesn't say which battery
 * found the weakness.
 */
export function batteryName(track?: "s1" | "s2" | null, source?: "memory"): string {
  if (track === "s1") return source === "memory" ? "memory" : "market data";
  return "attack library";
}

/**
 * "Weakest: A8, market data", or null when nothing was weak (a perfect grade: with every row at
 * 0%, the "worst" is just the first row) or the grade predates the field.
 */
export function weakestText(w: {
  worstClass?: string | null;
  worstTrack?: "s1" | "s2" | null;
  worstSource?: "memory";
  /** A leaderboard entry's grade, or a report's worst rate: either says whether anything was weak. */
  securityGrade?: number;
  worstRate?: number;
}): string | null {
  if (!w.worstClass || w.securityGrade === 100 || w.worstRate === 0) return null;
  return `Weakest: ${w.worstClass}, ${batteryName(w.worstTrack, w.worstSource)}`;
}

/** The weakest row of a report's grade, with its rate, for a one-line summary. */
export function weakestRow(s: Susceptibility): string | null {
  const text = weakestText(s);
  if (!text) return null;
  return `${text} (manipulated in ${Math.round(s.worstRate * 100)}% of its episodes)`;
}

/** Episodes where the agent acted on the attack; older results only have breaches. */
export const manipulatedOf = (c: { manipulated?: number; breaches: number }) =>
  c.manipulated ?? c.breaches;

/**
 * The market-data (S1) result across the open-source templates: how many acted on false data in
 * a graded class, per template and per template/model pair. Null when no template ran S1 (older
 * entries), so the headline stays on prompt injection.
 */
export function falseDataHeadline(entries: readonly LeaderboardRecord[]) {
  const evaluations = entries.filter((e) => e.kind === "framework" && e.s1Classes?.length);
  if (!evaluations.length) return null;
  const fooled = (e: LeaderboardRecord) =>
    Boolean(e.s1Classes?.some((c) => c.graded && c.manipulated > 0));
  const templates = new Map<string, boolean>();
  for (const e of evaluations) {
    const key = e.template ?? e.name;
    templates.set(key, (templates.get(key) ?? false) || fooled(e));
  }
  return {
    templates: templates.size,
    fooledTemplates: [...templates.values()].filter(Boolean).length,
    evaluations: evaluations.length,
    fooledEvaluations: evaluations.filter(fooled).length,
  };
}
