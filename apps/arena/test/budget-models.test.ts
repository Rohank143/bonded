import { expect, it, vi } from "vitest";
import { budgetModels } from "../src/budget-models.js";
import { fallbackForModels } from "../src/budget.js";
import { cascadePolicyInfo } from "../src/sentinel-policy.js";
vi.mock("../src/sentinel-policy.js", () => ({
  cascadePolicyInfo: vi.fn(() => ({ fallback: { model: "expensive" } })),
}));
it("includes the validated frozen-policy fallback alongside the unknown primary", async () => {
  const models = budgetModels({
    agent: "vulnerable",
    brain: "scripted",
    "sentinel-model": "laya:http://local",
    "sentinel-policy": "policy.json",
  });
  expect(cascadePolicyInfo).toHaveBeenCalledWith("policy.json");
  expect(models).toEqual([undefined, "expensive"]);
  expect(
    await fallbackForModels(models, async () => ({ inputPerMillion: 10, outputPerMillion: 20 })),
  ).toEqual({ inputPerMillion: 10, outputPerMillion: 20 });
});
