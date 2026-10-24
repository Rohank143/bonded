import { describe, expect, it } from "vitest";
import {
  batteryName,
  gradeBand,
  gradeTone,
  weakestRow,
  weakestText,
  weakestTile,
} from "./security";

describe("security score labels", () => {
  it("names the weakest row's battery", () => {
    expect(weakestText({ worstClass: "A8", worstTrack: "s1", securityGrade: 33 })).toBe(
      "Weakest: A8, market data",
    );
    expect(weakestText({ worstClass: "A2", worstTrack: "s1", worstSource: "memory" })).toBe(
      "Weakest: A2, memory",
    );
    expect(weakestText({ worstClass: "A1", worstTrack: "s2", securityGrade: 40 })).toBe(
      "Weakest: A1, attack library",
    );
    expect(batteryName(null)).toBe("attack library");
  });

  it("shows no weakest row when nothing was manipulated, or the grade predates the field", () => {
    expect(weakestText({ worstClass: "A1", worstTrack: "s2", securityGrade: 100 })).toBeNull();
    expect(weakestText({ securityGrade: 50 })).toBeNull();
    expect(
      weakestRow({
        grade: 100,
        worstClass: "A1",
        worstTrack: "s2",
        worstRate: 0,
        overallRate: 0,
        classes: [],
      }),
    ).toBeNull();
    expect(
      weakestRow({
        grade: 33,
        worstClass: "A8",
        worstTrack: "s1",
        worstRate: 0.67,
        overallRate: 0.1,
        classes: [],
      }),
    ).toBe("Weakest: A8, market data (manipulated in 67% of its episodes)");
  });
});

describe("agent page weakest tile", () => {
  const susceptibility = {
    grade: 33,
    worstClass: "A8" as const,
    worstTrack: "s1" as const,
    worstRate: 0.67,
    overallRate: 0.1,
    classes: [],
  };

  it("uses the report when the API has it", () => {
    expect(weakestTile({ report: { classes: [], susceptibility }, missing: false })).toEqual({
      value: "A8 · 67%",
      hint: "market data: sets the Bonded Score",
    });
  });

  it("falls back to the leaderboard entry when there's no hosted report", () => {
    expect(
      weakestTile({
        entry: { worstClass: "A2", worstTrack: "s1", securityGrade: 11 },
        missing: true,
      }),
    ).toEqual({ value: "A2", hint: "market data: sets the Bonded Score" });
    expect(
      weakestTile({
        entry: { worstClass: "A1", worstTrack: "s2", securityGrade: 100 },
        missing: true,
      }),
    ).toEqual({ value: "none", hint: "never manipulated" });
  });

  it("says the report isn't available instead of loading forever", () => {
    expect(weakestTile({ missing: true })).toEqual({
      value: "—",
      hint: "the full report isn't available",
    });
    expect(weakestTile({ missing: false }).hint).toBe("loading the report");
  });

  it("keeps loading while the leaderboard could still supply the weakest row", () => {
    expect(weakestTile({ missing: true, entryPending: true }).hint).toBe("loading the report");
    expect(weakestTile({ missing: true, entryPending: false }).value).toBe("—");
  });
});

describe("security grade bands", () => {
  it("colours 0–49, 50–79 and 80–100 differently, at the edges too", () => {
    expect([0, 49, 50, 79, 80, 100].map(gradeTone)).toEqual([
      "text-breach-solid",
      "text-breach-solid",
      "text-warn",
      "text-warn",
      "text-safe",
      "text-safe",
    ]);
    expect([17, 66, 100].map((g) => gradeBand(g).verdict)).toEqual([
      "Easily tricked",
      "Some weakness",
      "Resisted",
    ]);
  });
});
