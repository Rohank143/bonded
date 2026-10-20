import { describe, expect, it } from "vitest";
import {
  ATTACK_LIBRARY_VERSION,
  Leaderboard,
  LeaderboardEntry,
  leaderboardHeadline,
  libraryVersionStatus,
} from "../src/index.js";

const entry = (
  slug: string,
  kind: "framework" | "reference",
  a2Breaches: number,
): LeaderboardEntry =>
  LeaderboardEntry.parse({
    slug,
    name: slug,
    kind,
    framework: "AgentKit",
    model: "m",
    ratedAt: "2026-10-03T12:00:00.000Z",
    score: 40,
    tier: "CCC",
    expectedLossBps: 900,
    premiumRateBps: 1200,
    insurable: true,
    episodes: { attacks: 40, controls: 2, controlBreaches: 0 },
    classes: [
      { class: "A2", name: "Injection via content", episodes: 4, breaches: a2Breaches },
      { class: "A6", name: "Social engineering", episodes: 4, breaches: 4 },
    ],
    reportHash: `0x${"ab".repeat(32)}`,
    onchain: null,
    disclosure: { status: kind === "framework" ? "pending" : "not-needed" },
  });

describe("the leaderboard", () => {
  it("counts templates and template/model evaluations separately", () => {
    // Two templates, each on two models; template X fails on one of its models.
    const on = (slug: string, template: string, a2: number) => ({
      ...entry(slug, "framework", a2),
      template,
    });
    const entries = [
      on("x-haiku", "https://example.org/x", 0),
      on("x-deepseek", "https://example.org/x", 2),
      on("y-haiku", "https://example.org/y", 0),
      on("y-deepseek", "https://example.org/y", 0),
      entry("ref", "reference", 4),
    ];
    // A6 isn't an injection class, and reference agents aren't counted.
    expect(leaderboardHeadline(entries)).toEqual({
      templates: 2,
      failingTemplates: 1,
      evaluations: 4,
      failingEvaluations: 1,
    });
  });

  it("rejects duplicate slugs and unknown fields", () => {
    expect(() =>
      Leaderboard.parse([entry("a", "framework", 0), entry("a", "framework", 0)]),
    ).toThrow(/duplicate slug/);
    expect(() => LeaderboardEntry.parse({ ...entry("a", "framework", 0), payload: "x" })).toThrow();
  });
});

describe("attack library versions", () => {
  it("records the version a rating ran against, and still parses entries without one", () => {
    const base = entry("v", "reference", 0);
    expect(LeaderboardEntry.parse({ ...base, libraryVersion: 1 }).libraryVersion).toBe(1);
    expect(LeaderboardEntry.parse(base).libraryVersion).toBeUndefined();
    expect(LeaderboardEntry.safeParse({ ...base, libraryVersion: 0 }).success).toBe(false);
    expect(LeaderboardEntry.safeParse({ ...base, libraryVersion: 1.5 }).success).toBe(false);
  });

  it("tells current, older and unversioned results apart", () => {
    expect(libraryVersionStatus(ATTACK_LIBRARY_VERSION)).toBe("current");
    expect(libraryVersionStatus(undefined)).toBe("unversioned");
    expect(libraryVersionStatus(ATTACK_LIBRARY_VERSION - 1)).toBe("older");
  });
});
