import { describe, expect, it } from "vitest";
import { finishedRun } from "../test/byoa-fixtures";
import {
  actionLine,
  breachLine,
  classChange,
  compareRuns,
  fixesFor,
  scoreChange,
  surfaceLine,
  topFixes,
  type ActionableReport,
} from "./report-actions";

const fix = (id: string, prevents: number) => ({
  id,
  kind: "mandate" as const,
  title: `Fix ${id}`,
  prevents,
});

describe("the actionable report", () => {
  it("takes the API's top fixes, else the three that prevent the most", () => {
    const base = finishedRun().report!;
    const report: ActionableReport = {
      ...base,
      fixes: [fix("a", 1), fix("b", 5), fix("c", 3), fix("d", 2), fix("e", 0)],
    };
    expect(topFixes(report).map((f) => f.id)).toEqual(["b", "c", "d"]);
    expect(topFixes({ ...report, topFixes: ["a", "zzz", "b"] }).map((f) => f.id)).toEqual([
      "a",
      "b",
    ]);
    // A fix that prevents nothing isn't a top fix.
    expect(topFixes({ ...base, fixes: [fix("e", 0)] })).toEqual([]);
    expect(topFixes(null)).toEqual([]);
  });

  it("resolves a breach's fixes and says what the agent did", () => {
    const report = { ...finishedRun().report!, fixes: [fix("a", 1)] } as ActionableReport;
    expect(
      fixesFor({ class: "A1", breachType: "T1", lossUsd: 1, fixes: ["a", "gone"] }, report),
    ).toEqual([fix("a", 1)]);
    expect(actionLine({ tool: "transfer", args: { to: "0xBad", amount: "4000" } })).toBe(
      'transfer({"to":"0xBad","amount":"4000"})',
    );
    expect(actionLine({ tool: "transfer", args: { to: "0xBad" }, decoded: true })).toBe(
      'transfer({"to":"0xBad"}), decoded from an execute the agent signed',
    );
    expect(breachLine("T1_UNAUTHORIZED_TRANSFER")).toBe("a transfer the mandate doesn't allow");
    expect(breachLine("NEW_TYPE")).toBe("NEW_TYPE");
    expect(actionLine({ tool: "swap", args: {} })).toBe("swap()");
    expect(actionLine(null)).toBe("No action was recorded.");
    expect(surfaceLine("dm")).toBe("planted in messages");
    expect(surfaceLine(null)).toBeUndefined();
  });

  it("compares two runs by score and per-class breaches", () => {
    const before = finishedRun({ id: "r1" });
    const after = finishedRun({ id: "r2" });
    after.report = {
      ...after.report!,
      scoring: { ...after.report!.scoring, score: 81 },
      classes: after.report!.classes.map((c) => (c.class === "A1" ? { ...c, breaches: 0 } : c)),
    };
    before.report = { ...before.report!, scoring: { ...before.report!.scoring, score: 54 } };
    const c = compareRuns(before, after);
    expect(scoreChange(c)).toBe("54 → 81");
    expect(c.classes.map((d) => [d.class, classChange(d).text])).toEqual([
      ["A1", "1 fewer breach"],
      ["A2", "the same"],
    ]);
    expect(
      classChange({
        class: "X",
        name: "X",
        from: { breaches: 0, episodes: 5 },
        to: { breaches: 2, episodes: 5 },
      }),
    ).toEqual({ text: "2 more breaches", tone: "breach" });
    expect(
      classChange({ class: "X", name: "X", from: null, to: { breaches: 0, episodes: 1 } }).text,
    ).toBe("new in this rating");
  });
});
