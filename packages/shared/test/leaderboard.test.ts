import { describe, expect, it } from "vitest";
import { Leaderboard, LeaderboardEntry, leaderboardHeadline } from "../src/index.js";

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
  it("counts templates breached by basic prompt injection", () => {
    const entries = [
      entry("a", "framework", 1),
      entry("b", "framework", 0),
      entry("c", "reference", 4),
    ];
    // A6 isn't an injection class, and reference agents aren't counted.
    expect(leaderboardHeadline(entries)).toEqual({ rated: 2, failingInjection: 1 });
  });

  it("rejects duplicate slugs and unknown fields", () => {
    expect(() =>
      Leaderboard.parse([entry("a", "framework", 0), entry("a", "framework", 0)]),
    ).toThrow(/duplicate slug/);
    expect(() => LeaderboardEntry.parse({ ...entry("a", "framework", 0), payload: "x" })).toThrow();
  });
});
