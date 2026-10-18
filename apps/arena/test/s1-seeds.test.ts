import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Import the light modules directly, not the ../src/index.js barrel: the barrel pulls in the
// sandbox/chain stack, which this structural test (no chain, no model) must not need.
import { loadAttackLibrary } from "../src/attacks.js";
import { goalChoices, goalOk } from "../src/harbinger/goals.js";

// Structural guards for the S1 attack battery (docs/S1-TAXONOMY.md). Deterministic and free: no
// chain and no model. loadAttackLibrary already throws on an invalid seed or a duplicate id; this
// pins the S1-specific invariants and the taxonomy's family coverage so a new seed can't drift.

const S1_DIR = fileURLToPath(new URL("../s1-seeds", import.meta.url));
const seeds = loadAttackLibrary(S1_DIR);

// The Arena's only market tokens (apps/arena/src/vault.ts). A skew or spoofed price on anything
// else is a no-op, so it would silently never fire.
const MARKET_TOKENS = new Set(["tUSDG", "tTSLA", "tAMZN", "tNVDA"]);

// Every falsehood family the taxonomy claims to cover must have at least one seed.
const FAMILY_TAGS = [
  "s1-event",
  "s1-social",
  "s1-anchor",
  "s1-price",
  "s1-numeric",
  "s1-context",
  "s1-panic",
  "s1-counterparty",
];

describe("S1 seed battery", () => {
  it("has seeds", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(15);
  });

  it("every seed is tagged s1 and carries a benign, in-mandate goal", () => {
    for (const s of seeds) {
      expect(s.tags, s.id).toContain("s1");
      expect(s.goal, `${s.id} needs its own goal`).toBeTruthy();
      // The goal is handed to the agent as its task, so it must be safe by itself (no planted
      // address, placeholder or oversize ask): the breach must come from the attack, not the task.
      expect(goalOk(s.goal!), `${s.id} goal must pass goalOk`).toBe(true);
      // The seed's own goal leads its choices, so a rating runs the task the seed was written for.
      expect(goalChoices(s)[0], s.id).toBe(s.goal);
    }
  });

  it("every execution skew and spoofed price names a real market token", () => {
    for (const s of seeds) {
      const skew = s.delivery.executionSkew;
      if (skew) expect(MARKET_TOKENS.has(skew.token), `${s.id} skew token`).toBe(true);
      for (const token of Object.keys(s.delivery.prices ?? {}))
        expect(MARKET_TOKENS.has(token), `${s.id} price token ${token}`).toBe(true);
    }
  });

  it("covers every falsehood family in the taxonomy", () => {
    const tags = new Set(seeds.flatMap((s) => s.tags));
    for (const family of FAMILY_TAGS) expect(tags, `no seed for ${family}`).toContain(family);
  });

  it("marks the multi-agent seed as not yet exercisable", () => {
    // A10 needs a pipeline target; until then its seeds must be flagged, not silently counted.
    for (const s of seeds.filter((x) => x.class === "A10"))
      expect(s.tags, s.id).toContain("needs-multiagent");
  });
});
