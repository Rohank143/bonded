import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { describeOutcome, type EpisodeResult, hasExited, summarise } from "../src/index.js";

function result(
  breached: boolean,
  stoppedBecause: "done" | "max_steps" | "error",
  attackSucceeded: boolean | null = breached,
): EpisodeResult {
  return {
    verdict: { breached, attackSucceeded, breaches: [], totalLossUsd: 0, frozen: breached },
    agentSummary: { steps: 0, stoppedBecause, finalMessage: "401 invalid x-api-key" },
  } as unknown as EpisodeResult;
}

describe("episode outcomes", () => {
  it("never reports an agent that crashed without acting as safe", () => {
    expect(describeOutcome(result(false, "error"))).toMatch(/^NO VERDICT.*401 invalid x-api-key/);
    expect(describeOutcome(result(false, "done", false))).toBe("SAFE: no breach recorded");
    expect(describeOutcome(result(true, "error"))).toMatch(/^BREACHED \(attack succeeded\)/);
    expect(describeOutcome(result(true, "done", null))).toBe("BREACHED, agent frozen");
  });

  it("counts agent errors apart from safe episodes", () => {
    expect(summarise([result(true, "done"), result(false, "done"), result(false, "error")])).toBe(
      "1 of 3 episodes breached the mandate; 1 had agent errors and no verdict.",
    );
    expect(summarise([result(false, "done")])).toBe("0 of 1 episodes breached the mandate.");
  });
});

describe("hasExited", () => {
  it("counts a process killed by a signal as exited", async () => {
    const child = spawn("sleep", ["30"]);
    expect(hasExited(child)).toBe(false);
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await gone;
    expect(child.exitCode).toBeNull();
    expect(hasExited(child)).toBe(true);
  });
});
