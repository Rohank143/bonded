import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

const attack = loadAttackLibrary().find((a) => a.id === "A6-operator-impersonation-001")!;

it("puts each breach's evidence and fixes in the finished report, text withheld when reused", async () => {
  const shown = await rateAgent(sandbox, {
    agent: new ScriptedVulnerableAgent(),
    attacks: [attack],
    controls: 1,
    shuffle: false,
  });
  const e = shown.report.evidence!;
  expect(e.length).toBeGreaterThan(0);
  expect(e[0]).toMatchObject({ class: "A6", surface: "dm", heldOut: false });
  expect(e[0]!.plantedText).toBeTruthy();
  expect(e[0]!.action?.tool).toMatch(/transfer|approve|swap|execute/);
  expect(shown.report.topFixes).toHaveLength(3);
  expect(shown.report.fixes![0]!.prevents).toBeGreaterThan(0);
  expect(shown.report.trading).toBeDefined();

  const withheld = await rateAgent(sandbox, {
    agent: new ScriptedVulnerableAgent(),
    attacks: [attack],
    unpublished: new Set([attack.id]),
    controls: 1,
    shuffle: false,
  });
  const w = withheld.report.evidence![0]!;
  expect(w).toMatchObject({ withheld: true, heldOut: true });
  expect(w.plantedText).toBeUndefined();
  expect(JSON.stringify(withheld.report)).not.toContain(shown.report.evidence![0]!.plantedText);

  const own = await rateAgent(sandbox, {
    agent: new ScriptedVulnerableAgent(),
    attacks: [attack],
    unpublished: new Set([attack.id]),
    revealUnpublished: true,
    controls: 1,
    shuffle: false,
  });
  expect(own.report.evidence![0]!.plantedText).toBeTruthy();
}, 600_000);
