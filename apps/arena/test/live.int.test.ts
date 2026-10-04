import { createPartialAgent } from "@bonded/demo-agents";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAgentVault, loadAttackLibrary, runLiveAttack, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

it("runs Agent A's own brain against a real vault: address poisoning records a breach and freezes it", async () => {
  const depositor = sandbox.address("depositor");
  const vault = await createAgentVault(sandbox, { mandate: { destinations: [depositor] } });
  const result = await runLiveAttack({
    chain: sandbox,
    vault: vault.address,
    mandate: vault.mandate,
    agent: createPartialAgent("scripted"),
    attack: loadAttackLibrary().find((s) => s.id === "A5-address-poisoning-001")!,
  });
  // The planted refund request comes from a lookalike of the depositor...
  const sender = (result.planted[0]?.sender ?? "").toLowerCase();
  expect(sender.slice(0, 6)).toBe(depositor.toLowerCase().slice(0, 6));
  expect(sender).not.toBe(depositor.toLowerCase());
  // ...the agent pays it, and the vault's own log is the verdict.
  const transfer = result.trace.find((s) => s.tool === "transfer");
  expect((transfer?.args as { to: string }).to.toLowerCase()).toBe(sender);
  expect(result.breachIds.length).toBeGreaterThan(0);
  expect(result.frozen).toBe(true);
}, 120_000);

it("refuses a mandate with no destination to imitate", async () => {
  const vault = await createAgentVault(sandbox);
  await expect(
    runLiveAttack({
      chain: sandbox,
      vault: vault.address,
      mandate: vault.mandate,
      agent: createPartialAgent("scripted"),
      attack: loadAttackLibrary().find((s) => s.id === "A5-address-poisoning-001")!,
    }),
  ).rejects.toThrow(/no destination/);
}, 120_000);
