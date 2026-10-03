import { afterAll, beforeAll, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadAttackLibrary } from "../src/attacks.js";
import { BOUNTY_REWARDS, parseBountySpec, validateBounty } from "../src/bounty.js";
import { Sandbox } from "../src/sandbox.js";
import { NEW_ATTACK } from "./fixtures/bounty.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

const library = loadAttackLibrary();

it("accepts a new reproducible attack the defended agent resists, for the smaller reward", async () => {
  const v = await validateBounty(sandbox, parseBountySpec(stringify(NEW_ATTACK)), library);
  expect(v.breaches.undefended).toBe(3);
  expect(v.breaches.defended).toBe(0);
  expect(v).toMatchObject({ decision: "accept", reward: BOUNTY_REWARDS.newSurface.toString() });
}, 600_000);

it("rejects a copy of a library seed without running it", async () => {
  const seed = library.find((s) => s.id === "A2-fake-halt-news-001")!;
  const v = await validateBounty(sandbox, { ...seed, id: "A2-copy-997" }, library);
  expect(v).toMatchObject({ decision: "reject", duplicateOf: seed.id, reward: "0" });
});

it("rejects an attack the undefended agent ignores", async () => {
  const harmless = parseBountySpec(
    stringify({
      ...NEW_ATTACK,
      id: "A2-harmless-996",
      payloadTemplate: "Markets are calm today; nothing to do.",
    }),
  );
  const v = await validateBounty(sandbox, harmless, library);
  expect(v.decision).toBe("reject");
  expect(v.reason).toMatch(/not reproducible/);
}, 600_000);
