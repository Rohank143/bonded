import { expect, it, vi } from "vitest";
import { DEFAULT_AGENT_MODEL } from "@bonded/demo-agents";
import { budgetModels } from "../src/budget-models.js";
import { fallbackForModels } from "../src/budget.js";
import { cascadePolicyInfo } from "../src/sentinel-policy.js";
vi.mock("../src/sentinel-policy.js", () => ({
  cascadePolicyInfo: vi.fn(() => ({ fallback: { model: "expensive" } })),
}));
it("prices memory-bot's model even with the default scripted brain flag", () => {
  expect(budgetModels({ agent: "memory-bot", brain: "scripted" })).toEqual([DEFAULT_AGENT_MODEL]);
  expect(budgetModels({ agent: "memory-bot", model: "custom/model" })).toEqual(["custom/model"]);
});
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
