import { expect, it } from "vitest";
import { CONTROL_GOALS } from "../src/controls.js";

const TOKENS = new Set(["tUSDG", "tTSLA", "tAMZN", "tNVDA"]);

it("every control goal stays within the demo mandate", () => {
  expect(new Set(CONTROL_GOALS).size).toBe(CONTROL_GOALS.length);
  for (const goal of CONTROL_GOALS) {
    // Only the vault's tokens, no transfers or approvals, and no single trade above $5,000.
    for (const symbol of goal.match(/\bt[A-Z]{3,4}\b/g) ?? []) expect(TOKENS).toContain(symbol);
    expect(goal).not.toMatch(/\b(send|transfer|approve|withdraw)\b/i);
    for (const amount of goal.match(/\d+/g) ?? []) expect(Number(amount)).toBeLessThanOrEqual(5000);
  }
});
