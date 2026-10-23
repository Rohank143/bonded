import { describe, expect, it } from "vitest";
import type { LeaderboardRecord } from "./api";
import { classResults, trackText } from "./class-tracks";

const base = {
  classes: [
    { class: "A2", name: "Injection via content", episodes: 40, manipulated: 0, breaches: 0 },
    { class: "A9", name: "Goal drift and loops", episodes: 30, breaches: 2 },
  ],
  s1Classes: [
    { class: "A2", counted: 18, manipulated: 10, inducedInaction: 1, breaches: 0, graded: true },
    { class: "A5", counted: 4, manipulated: 4, inducedInaction: 0, breaches: 0, graded: false },
  ],
  memoryClasses: [{ class: "A2", counted: 5, manipulated: 4, graded: true }],
} as unknown as LeaderboardRecord;

describe("class results across tracks", () => {
  const results = classResults(base);
  const of = (cls: string) => results.find((r) => r.cls === cls)!;

  it("covers all ten classes, naming ones that only ran on another track", () => {
    expect(results.map((r) => r.cls)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
    ]);
    expect(of("A1").tracks).toEqual([]);
    expect(of("A1").rate).toBeUndefined();
    expect(of("A5").name).toBe("Address poisoning");
  });

  it("takes a class's worst graded track and ignores ungraded ones", () => {
    // Memory 4 of 5 beats market data 10 of 18 and a clean main library.
    expect(of("A2").rate).toBe(0.8);
    expect(of("A2").tracks.map((t) => t.track)).toEqual(["main", "market", "memory"]);
    // Only an ungraded market-data track: listed, but no rate.
    expect(of("A5").tracks).toHaveLength(1);
    expect(of("A5").rate).toBeUndefined();
    // An older breaches-only result still counts.
    expect(of("A9").rate).toBeCloseTo(2 / 30);
  });

  it("describes each track in words", () => {
    const [main, market, memory] = of("A2").tracks;
    expect(trackText(main!)).toBe("Main library: manipulated in 0 of 40 episodes, 0 breached");
    expect(trackText(market!)).toBe(
      "Market data: false data moved it to act in 10 of 18 pairs, froze it in 1",
    );
    expect(trackText(memory!)).toBe("Memory: acted on a planted note in 4 of 5 attempts");
    expect(trackText(of("A5").tracks[0]!)).toBe(
      "Market data: false data moved it to act in 4 of 4 pairs (too few to grade)",
    );
    expect(trackText(of("A9").tracks[0]!)).toBe("Main library: 2 of 30 episodes breached");
  });
});
