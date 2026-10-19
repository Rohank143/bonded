import { describe, expect, it } from "vitest";
import { gradeRowLines, memoryLines, type RatingReport, s1Lines } from "../src/rate.js";

// The report sections for the grade's rows and the S1 and memory batteries (no chain, no model).

const base = { susceptibility: undefined } as unknown as RatingReport;

describe("rating report: the grade's rows and the S1 and memory batteries", () => {
  it("lists every grade row worst first and marks the one that set the grade", () => {
    const md = gradeRowLines({
      ...base,
      susceptibility: {
        grade: 25,
        worstClass: "A8",
        worstTrack: "s1",
        worstRate: 0.75,
        overallRate: 0.3,
        classes: [
          { class: "A2", track: "s2", episodes: 10, manipulated: 1, rate: 0.1 },
          { class: "A8", track: "s1", episodes: 8, manipulated: 6, rate: 0.75 },
          { class: "A2", track: "s1", source: "memory", episodes: 5, manipulated: 2, rate: 0.4 },
        ],
      },
    } as RatingReport).join("\n");
    expect(md).toContain("## What set the security grade");
    const rows = md.split("\n").filter((l) => l.startsWith("| A"));
    expect(rows[0]).toBe("| A8 | Market data (S1) | 8 | 6 | 75.0% (sets the grade) |");
    expect(rows[1]).toBe("| A2 | Memory (S1) | 5 | 2 | 40.0% |");
    expect(rows[2]).toBe("| A2 | Attack library (S2) | 10 | 1 | 10.0% |");
  });

  it("shows the S1 battery per seed, with freezes apart from induced action", () => {
    const md = s1Lines({
      ...base,
      s1: [
        {
          seed: "A8-halt-panic-standing-001",
          class: "A8",
          pairs: 2,
          countedPairs: 2,
          manipulated: 0,
          inducedInaction: 2,
          breached: 0,
          controlBreached: 0,
          graded: true,
          avgInducedLossUsd: 0,
        },
      ],
    } as unknown as RatingReport).join("\n");
    expect(md).toContain("## Market-data battery (S1)");
    expect(md).toContain("| A8-halt-panic-standing-001 | A8 | 2 | 2 | 0 | 2 | 0 | $0 | yes |");
  });

  it("says why the memory battery didn't run, and omits both sections when nothing ran", () => {
    expect(
      memoryLines({
        ...base,
        memory: { skipped: "the agent keeps no memory", seeds: [] },
      } as RatingReport),
    ).toContain("Not run: the agent keeps no memory.");
    expect(s1Lines(base)).toEqual([]);
    expect(memoryLines(base)).toEqual([]);
    expect(gradeRowLines(base)).toEqual([]);
  });
});
