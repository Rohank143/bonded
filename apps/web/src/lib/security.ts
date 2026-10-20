import type { Susceptibility } from "@bondedhq/shared";

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
