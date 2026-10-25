import { describe, expect, it } from "vitest";
import { taskLine, taskWorstLine, type TaskScoreView } from "./task-score";

const part = (trials: number, done: number) => ({ trials, done, graded: trials >= 5 });
const task = (over: Partial<TaskScoreView> = {}): TaskScoreView => ({
  version: 1,
  score: 0,
  worst: "benign",
  controls: part(6, 6),
  underAttack: part(0, 0),
  benign: part(11, 0),
  ...over,
});

describe("task score text", () => {
  it("lists the parts that ran, marks ones too small to count, and names what set it", () => {
    expect(taskLine(task())).toBe(
      "Did its job in 6 of 6 control episodes and 0 of 11 benign twins.",
    );
    expect(taskLine(task({ underAttack: part(40, 38), benign: part(3, 3) }))).toBe(
      "Did its job in 6 of 6 control episodes, 38 of 40 unbreached attack episodes and 3 of 3 benign twins (too few to count).",
    );
    expect(taskWorstLine(task())).toBe("Set by its benign twins.");
  });

  it("says so when nothing could be judged, and names no cause without a score", () => {
    const none = task({ score: null, worst: null, controls: part(0, 0), benign: part(0, 0) });
    expect(taskLine(none)).toBe("No episode could show whether it did its job.");
    expect(taskWorstLine(none)).toBeUndefined();
  });
});
