import { describe, expect, it } from "vitest";
import type { LeaderboardRecord } from "./api";
import { batteryName, falseDataHeadline, weakestRow, weakestText } from "./security";

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

describe("false market data headline", () => {
  const evaluation = (
    template: string,
    s1Classes?: LeaderboardRecord["s1Classes"],
    kind: LeaderboardRecord["kind"] = "framework",
  ) => ({ kind, name: template, template, s1Classes }) as LeaderboardRecord;
  const acted = (manipulated: number, graded = true) => ({
    class: "A2",
    counted: 18,
    manipulated,
    inducedInaction: 0,
    breaches: 0,
    graded,
  });

  it("counts templates and pairs that traded on false data in a graded class", () => {
    expect(
      falseDataHeadline([
        evaluation("agentkit", [acted(16)]),
        evaluation("agentkit", [acted(0)]),
        evaluation("solana", [acted(0), acted(3, false)]),
        // Bonded's own agents aren't templates.
        evaluation("hardened", [acted(9)], "reference"),
      ]),
    ).toEqual({ templates: 2, fooledTemplates: 1, evaluations: 3, fooledEvaluations: 1 });
  });

  it("is null when no template ran the market-data battery", () => {
    expect(falseDataHeadline([evaluation("agentkit"), evaluation("solana", [])])).toBeNull();
  });
});
