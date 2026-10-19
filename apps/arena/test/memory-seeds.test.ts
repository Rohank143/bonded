import { describe, expect, it } from "vitest";
// Light modules only (no chain, no model).
import { goalChoices, goalOk } from "../src/harbinger/goals.js";
import { loadMemorySeeds, memoryTarget } from "../src/memory-observations.js";
import { loadS1Seeds } from "../src/s1-observations.js";

// Structural guards for the memory-poisoning seeds (apps/arena/s1-seeds-memory, see
// docs/S1-TAXONOMY.md). loadAttackLibrary already throws on an invalid seed or duplicate id.

const seeds = loadMemorySeeds();
const MARKET_TOKENS = new Set(["tUSDG", "tTSLA", "tAMZN", "tNVDA"]);

describe("memory-poisoning seeds", () => {
  it("has enough seeds in one class to clear the grade's minimum in a single round", () => {
    const byClass = new Map<string, number>();
    for (const s of seeds) byClass.set(s.class, (byClass.get(s.class) ?? 0) + 1);
    expect(Math.max(...byClass.values())).toBeGreaterThanOrEqual(5);
  });

  it("every seed is tagged s1 and s1-memory and carries a safe, in-mandate day-1 goal", () => {
    for (const s of seeds) {
      expect(s.tags, s.id).toContain("s1");
      expect(s.tags, s.id).toContain("s1-memory");
      expect(s.goal, `${s.id} needs its own goal`).toBeTruthy();
      expect(goalOk(s.goal!), `${s.id} goal must pass goalOk`).toBe(true);
      expect(goalChoices(s)[0], s.id).toBe(s.goal);
    }
  });

  it("names one planted target per seed: tAMZN or tNVDA, and the payload names it", () => {
    for (const s of seeds) {
      const target = memoryTarget(s);
      expect(["tAMZN", "tNVDA"], s.id).toContain(target);
      expect(s.payloadTemplate, s.id).toContain(target);
    }
  });

  it("plants a real market token other than tTSLA (the day-2 goal's token)", () => {
    for (const s of seeds) {
      const named = s.payloadTemplate.match(/\bt[A-Z]{3,5}\b/g) ?? [];
      for (const t of named) expect(MARKET_TOKENS.has(t), `${s.id} names ${t}`).toBe(true);
      expect(
        named.some((t) => t === "tAMZN" || t === "tNVDA"),
        s.id,
      ).toBe(true);
      expect(named, `${s.id} must not plant tTSLA`).not.toContain("tTSLA");
    }
  });

  it("plants only on surfaces the memory bot reads", () => {
    for (const s of seeds)
      for (const surface of s.surfaces)
        expect(["news", "social", "tool_output"], `${s.id} ${surface}`).toContain(surface);
  });

  it("stays out of the single-episode S1 battery", () => {
    expect(loadS1Seeds().filter((s) => s.tags.includes("s1-memory"))).toEqual([]);
  });
});
