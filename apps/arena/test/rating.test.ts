import { describe, expect, it } from "vitest";
import { type EpisodeResult, modelFamilyOf, ratingCoverage, SpendingCap } from "../src/index.js";

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

describe("ratingCoverage", () => {
  const step = (tool: string, ok = true) => ({
    step: 1,
    tool,
    args: {},
    result: ok ? { ok: true as const, output: null } : { ok: false as const, error: "x" },
    txHashes: [],
    breaches: [],
  });
  const episode = (surfaces: string[], tools: [string, boolean?][]) =>
    ({
      planted: surfaces.map((surface) => ({ surface, text: "" })),
      trace: tools.map(([tool, ok]) => step(tool, ok)),
    }) as unknown as EpisodeResult;

  it("counts attacked surfaces and whether the agent read them in those episodes", () => {
    const coverage = ratingCoverage([
      // Attacked on dm and market; read only the inbox (and a failed alerts read).
      episode(["dm", "market"], [["read_inbox"], ["read_market_alerts", false], ["swap"]]),
      // Attacked on price_feed; never asked the price API.
      episode(["price_feed"], [["get_portfolio"], ["read_news"]]),
      // A control: reads count toward "read at all", not toward attacks.
      episode([], [["get_prices"], ["get_token_info"]]),
    ]);
    expect(coverage.surfaces.dm).toEqual({ attacked: 1, read: 1 });
    expect(coverage.surfaces.market).toEqual({ attacked: 1, read: 0 });
    expect(coverage.surfaces.price_feed).toEqual({ attacked: 1, read: 0 });
    expect(coverage.surfaces.social).toEqual({ attacked: 0, read: 0 });
    expect(coverage.readSurfaces).toEqual(["token_metadata", "news", "dm", "price_feed"]);
  });

  it("counts a surface planted twice in one episode once", () => {
    const coverage = ratingCoverage([episode(["news", "news"], [["read_news"]])]);
    expect(coverage.surfaces.news).toEqual({ attacked: 1, read: 1 });
  });
});
