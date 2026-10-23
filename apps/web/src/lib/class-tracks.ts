import { ATTACK_CLASSES, AttackClassId } from "@bondedhq/shared";
import type { LeaderboardRecord } from "./api";
import { manipulatedOf } from "./security";

export const CLASSES = AttackClassId.options;

/**
 * One track's result for an attack class: the main library (S2), the market-data battery (S1)
 * or the memory battery. `hits` of `of` is the manipulation count the grade uses; `graded` is
 * whether the track had enough results to enter the grade.
 */
export interface TrackResult {
  track: "main" | "market" | "memory";
  hits: number;
  of: number;
  graded: boolean;
  /** Main library: breaches recorded (vault-blocked ones included). */
  breaches?: number;
  /** Market data: pairs where the lie only froze the agent (reported, not graded). */
  froze?: number;
  /** An older main-library result that measured breaches only. */
  breachesOnly?: boolean;
}

export interface ClassResult {
  cls: AttackClassId;
  name: string;
  tracks: TrackResult[];
  /** The worst graded track's rate, or undefined when no graded track ran. */
  rate?: number;
}

export const TRACK_LABEL: Record<TrackResult["track"], string> = {
  main: "Main library",
  market: "Market data",
  memory: "Memory",
};

/**
 * Every attack class of a leaderboard entry with its results on each track that ran. Market data
 * and memory run the same classes as the main library through another channel, so a class's
 * standing is its worst graded track: the rate the security grade uses.
 */
export function classResults(e: LeaderboardRecord): ClassResult[] {
  return CLASSES.map((cls) => {
    const tracks: TrackResult[] = [];
    const c = e.classes.find((x) => x.class === cls);
    if (c && c.episodes > 0)
      tracks.push(
        c.manipulated === undefined
          ? { track: "main", hits: c.breaches, of: c.episodes, graded: true, breachesOnly: true }
          : {
              track: "main",
              hits: manipulatedOf(c),
              of: c.episodes,
              graded: true,
              breaches: c.breaches,
            },
      );
    const s1 = e.s1Classes?.find((x) => x.class === cls);
    if (s1 && s1.counted > 0)
      tracks.push({
        track: "market",
        hits: s1.manipulated,
        of: s1.counted,
        graded: s1.graded,
        froze: s1.inducedInaction,
      });
    const memory = e.memoryClasses?.find((x) => x.class === cls);
    if (memory && memory.counted > 0)
      tracks.push({
        track: "memory",
        hits: memory.manipulated,
        of: memory.counted,
        graded: memory.graded,
      });
    const graded = tracks.filter((t) => t.graded);
    return {
      cls,
      name: c?.name ?? ATTACK_CLASSES[cls].name,
      tracks,
      ...(graded.length ? { rate: Math.max(...graded.map((t) => t.hits / t.of)) } : {}),
    };
  });
}

/** A track's result in words, e.g. "Market data: false data moved it to act in 8 of 12 pairs". */
export function trackText(t: TrackResult): string {
  const text =
    t.track === "main"
      ? t.breachesOnly
        ? `${t.hits} of ${t.of} episodes breached`
        : `manipulated in ${t.hits} of ${t.of} episodes, ${t.breaches ?? 0} breached`
      : t.track === "market"
        ? `false data moved it to act in ${t.hits} of ${t.of} pairs` +
          (t.froze ? `, froze it in ${t.froze}` : "")
        : `acted on a planted note in ${t.hits} of ${t.of} attempts`;
  return `${TRACK_LABEL[t.track]}: ${text}${t.graded ? "" : " (too few to grade)"}`;
}

/** A square's colour for a manipulation rate: clean, some, or half and over. */
export const toneFor = (rate: number) =>
  rate === 0
    ? "bg-brand-bright/45 ring-1 ring-inset ring-brand-bright/70"
    : rate < 0.5
      ? "bg-breach/45 ring-1 ring-inset ring-breach/60"
      : "bg-breach-solid";
