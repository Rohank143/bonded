import type { Susceptibility } from "@bondedhq/shared";
import type { LeaderboardRecord, Report } from "./api";

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
 * The agent page's "Weakest" tile. From the rating report when the API has it; otherwise from the
 * leaderboard entry for the same rating (agents rated outside the hosted service, whose full report
 * the API doesn't hold); otherwise it says the report isn't available rather than loading forever.
 */
export function weakestTile(input: {
  report?: Pick<Report, "classes" | "susceptibility">;
  /** The leaderboard entry whose report hash matches the on-chain score, if any. */
  entry?: Pick<LeaderboardRecord, "worstClass" | "worstTrack" | "worstSource" | "securityGrade">;
  /** The report can't be loaded (no hosted run for this score, or the request failed). */
  missing: boolean;
  /** The leaderboard is still loading, so an entry may yet arrive: keep loading until it settles. */
  entryPending?: boolean;
}): { value: string; hint: string } {
  const { report, entry, missing, entryPending } = input;
  if (report) {
    const grade = report.susceptibility;
    // Nothing was weak when no row was ever manipulated (then the "worst" is just the first row).
    if (grade?.worstClass && grade.worstRate > 0)
      return {
        value: `${grade.worstClass} · ${Math.round(grade.worstRate * 100)}%`,
        hint: `${batteryName(grade.worstTrack, grade.worstSource)}: sets the Bonded Score`,
      };
    const weak = report.classes.filter((c) => manipulatedOf(c) > 0);
    return weak.length
      ? {
          value: `${weak.length} of ${report.classes.length} classes`,
          hint: weak.map((c) => c.name.toLowerCase()).join(", "),
        }
      : { value: "none", hint: "never manipulated" };
  }
  if (entry && weakestText(entry))
    return {
      value: entry.worstClass!,
      hint: `${batteryName(entry.worstTrack, entry.worstSource)}: sets the Bonded Score`,
    };
  if (entry?.securityGrade === 100) return { value: "none", hint: "never manipulated" };
  if (missing && !entryPending) return { value: "—", hint: "the full report isn't available" };
  return { value: "…", hint: "loading the report" };
}

/**
 * Severity bands for the security grade, worst first: 0–49 is easily tricked, 50–79 has a
 * weakness, 80–100 resisted. Colour only; the number is the measurement.
 */
export const GRADE_BANDS = [
  {
    min: 0,
    label: "0–49: easily tricked",
    verdict: "Easily tricked",
    tone: "text-breach-solid",
    dot: "bg-breach-solid",
  },
  {
    min: 50,
    label: "50–79: some weakness",
    verdict: "Some weakness",
    tone: "text-warn",
    dot: "bg-warn",
  },
  { min: 80, label: "80–100: resisted", verdict: "Resisted", tone: "text-safe", dot: "bg-safe" },
] as const;

/** The band a security grade falls in. */
export const gradeBand = (grade: number) => [...GRADE_BANDS].reverse().find((b) => grade >= b.min)!;

/** The text colour for a security grade's band. */
export const gradeTone = (grade: number) => gradeBand(grade).tone;
