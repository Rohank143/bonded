import { describe, expect, it } from "vitest";
import { modelFamilyOf, SpendingCap } from "../src/index.js";

describe("SpendingCap", () => {
  it("adds reported cost and stops at the cap", () => {
    const cap = new SpendingCap({ maxUsd: 0.05 });
    cap.add({ inputTokens: 1000, outputTokens: 100, costUsd: 0.03 });
    expect(cap.exceeded).toBe(false);
    cap.add({ inputTokens: 1000, outputTokens: 100, costUsd: 0.03 });
    expect(cap.exceeded).toBe(true);
    expect(cap.summary()).toMatchObject({ estimated: false, inputTokens: 2000, outputTokens: 200 });
  });

  it("estimates cost from tokens when the endpoint reports none, and says so", () => {
    const cap = new SpendingCap({
      maxUsd: 1,
      fallbackPrice: { inputPerMillion: 2, outputPerMillion: 10 },
    });
    cap.add({ inputTokens: 500_000, outputTokens: 10_000 });
    expect(cap.summary().spentUsd).toBeCloseTo(1.1, 9);
    expect(cap.summary().estimated).toBe(true);
    expect(cap.exceeded).toBe(true);
  });

  it("ignores agents with no model usage", () => {
    const cap = new SpendingCap({ maxUsd: 0 });
    cap.add(undefined);
    expect(cap.summary().spentUsd).toBe(0);
  });
});

describe("modelFamilyOf", () => {
  it("maps agent names to the attestation's model family", () => {
    expect(modelFamilyOf("vulnerable-agent/scripted")).toBe("unknown");
    expect(modelFamilyOf("hardened-agent/deepseek/deepseek-v4.1-flash")).toBe("deepseek");
    expect(modelFamilyOf("vulnerable-agent/anthropic/claude-sonnet-5")).toBe("anthropic-claude");
    expect(modelFamilyOf("vulnerable-agent/qwen/qwen3-coder")).toBe("qwen");
    expect(modelFamilyOf("decision-agent/llm/x")).toBe("decision-model");
    expect(modelFamilyOf("vulnerable-agent/some/new-model")).toBe("other");
  });
});
