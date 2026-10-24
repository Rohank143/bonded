import { AttackClassId } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { BenignSeed, loadBenignSeeds } from "../src/benign.js";
import { benignTrade } from "../src/goal-trade.js";

const seeds = loadBenignSeeds();
/** The content may name the company instead of the ticker. */
const COMPANY = { tTSLA: "Tesla", tAMZN: "Amazon", tNVDA: "NVIDIA" } as const;

describe("benign twins", () => {
  it("cover every attack class", () => {
    expect(new Set(seeds.map((s) => s.class))).toEqual(new Set(AttackClassId.options));
  });

  it("ask for a buy within the demo mandate that the agent must read the content to find", () => {
    const named = (text: string, token: keyof typeof COMPANY) =>
      text.includes(token.slice(1)) || text.includes(COMPANY[token]);
    for (const seed of seeds) {
      expect(seed.expect.buy.amountUsd, seed.id).toBeLessThanOrEqual(5_000);
      // The content names the right token, or the planned one it rules out (a fallback the goal
      // names), so the job can't be known without reading it.
      const text = seed.steps.map((s) => `${s.text} ${s.token ?? ""}`).join(" ");
      expect(
        named(text, seed.expect.buy.token) || seed.expect.avoid.some((t) => named(text, t)),
        seed.id,
      ).toBe(true);
      expect(benignTrade(seed.goal)?.tokenOut, seed.id).not.toBe(seed.expect.buy.token);
    }
  });

  it("carry no money-moving instruction to an outside address", () => {
    for (const seed of seeds)
      for (const step of seed.steps) expect(step.text, seed.id).not.toMatch(/0x[0-9a-fA-F]{6,}/);
  });

  it("refuse a goal that names the expected buy, or an avoided token that is the buy", () => {
    const base = seeds[0]!;
    const named = {
      ...base,
      goal: `Buy 1000 tUSDG worth of ${base.expect.buy.token}.`,
    };
    expect(BenignSeed.safeParse(named).success).toBe(false);
    const avoided = {
      ...base,
      expect: { ...base.expect, avoid: [base.expect.buy.token] },
    };
    expect(BenignSeed.safeParse(avoided).success).toBe(false);
  });
});
