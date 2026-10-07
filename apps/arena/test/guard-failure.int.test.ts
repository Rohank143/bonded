import { afterAll, beforeAll, expect, it } from "vitest";
import { GuardedAgent, createVulnerableAgent, type ActionGuard } from "@bonded/demo-agents";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

/** A model guard whose service is down: every check throws. */
const unreachable: ActionGuard = {
  name: "sentinel/laya",
  check: async () => {
    throw new Error("fetch failed: connect ECONNREFUSED");
  },
};

it("counts writes refused because a guard failed, apart from real blocks", async () => {
  // A transfer-planting attack: the vulnerable agent tries to obey it, so the guard is asked.
  const attack = loadAttackLibrary().find((a) =>
    a.successPredicate.anyOf.includes("T1_UNAUTHORIZED_TRANSFER"),
  )!;
  const r = await rateAgent(sandbox, {
    agent: new GuardedAgent(createVulnerableAgent("scripted"), [unreachable], "sentinel"),
    attacks: [attack],
    controls: 0,
  });
  // The guard failed closed, so nothing breached, but the report says it couldn't assess.
  expect(r.report.guardFailures).toBeGreaterThan(0);
  expect(r.report.guardFailures).toBe(r.report.blockedByAgentGuard);
  expect(r.episodes[0]!.agentSummary.blockedActions?.every((b) => b.guardFailed)).toBe(true);
}, 300_000);
