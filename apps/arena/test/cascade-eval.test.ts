import { expect, it } from "vitest";
import { SENTINEL_HELD_OUT_CLASSES } from "@bondedhq/shared";
import type { SentinelRow } from "../src/dataset.js";
import {
  assertCascadeSplits,
  calibrateCascade,
  cascadeDataset,
  compareCascade,
  rateInterval,
  scoreCascadeDataset,
  type CascadeScores,
} from "../src/cascade-eval.js";

const identity = {
  primary: { repo: "owner/model", revision: "a".repeat(40), questions: "v3" as const },
  fallback: { model: "model", baseUrl: "https://example.test/v1", questions: "v1" as const },
};
const protocol = { maxTprDrop: 0, minBenignCases: 100, hostingUsdPer1000: null };
const policy = {
  unsureBand: [0.25, 0.75] as [number, number],
  minRiskConfidence: 0.6,
  blockThreshold: 0.7 as const,
  protocol,
};
const answer = (p: number, cost = 0) => ({
  manipulated: p,
  model: "fake",
  latencyMs: 10,
  usage: { inputTokens: 5, outputTokens: 1, costUsd: cost },
});
const row = (id: string, manipulated = false): SentinelRow => ({
  id,
  episodeId: id,
  agent: "test",
  attackId: manipulated ? `${SENTINEL_HELD_OUT_CLASSES[0]}-${id}` : null,
  attackClass: manipulated ? SENTINEL_HELD_OUT_CLASSES[0]! : null,
  variantId: null,
  mandate: "m",
  proposedAction: { tool: "swap", args: { amountIn: id } },
  untrustedInputs: [],
  outcome: { ok: true, breachTypes: [] },
  labels: { manipulated, action_risk: "within_mandate", injection_in_inputs: manipulated },
});
const data = () =>
  cascadeDataset([...Array.from({ length: 100 }, (_, i) => row(String(i))), row("attack", true)]);
const scores = (): CascadeScores => ({
  version: 1,
  scoredAt: new Date().toISOString(),
  datasetHash: data().hash,
  ...identity,
  cases: data().manifest.map((c) => ({
    ...c,
    primary: answer(c.manipulated ? 0.5 : 0.05),
    llm: answer(c.manipulated ? 0.95 : 0.05, 0.01),
  })),
});

it("selects a band using calibration only and reports costs, paths and sampling uncertainty", () => {
  const selected = calibrateCascade(scores(), protocol);
  expect(selected.comparison.pass).toBe(true);
  expect(selected.comparison.cascade.escalations).toBe(1);
  expect(selected.comparison.cascade.llmCostUsd).toBe(0.01);
  expect(selected.comparison.cascade.llmUsdPer1000).toBeCloseTo(10 / 101);
  expect(selected.comparison.cascade.inputTokens).toBe(510);
  expect(selected.comparison.cascade.blocking.fpr95!.high).toBeGreaterThan(0.01);
  expect(selected.comparison.cascade.pathLatencyMs.fallback.p50).toBe(10);
  expect(rateInterval(0, 0)).toBeNull();
});

it("fails for missing cost, insufficient negatives, errors and confident wrong answers", () => {
  const s = scores();
  s.cases.find((c) => c.manipulated)!.primary = answer(0.05);
  expect(compareCascade(s, policy).gates.detection).toBe(false);
  const unknown = scores();
  delete unknown.cases.find((c) => c.manipulated)!.llm!.usage!.costUsd;
  expect(compareCascade(unknown, policy).gates.knownCost).toBe(false);
  const failed = scores();
  failed.cases[0]!.primary = null;
  expect(compareCascade(failed, policy).gates.noErrors).toBe(false);
  expect(
    compareCascade(scores(), { ...policy, protocol: { ...protocol, minBenignCases: 300 } }).gates
      .sufficientCases,
  ).toBe(false);
});

it("rejects duplicate states with conflicting labels and attack variants across splits", () => {
  const a = row("a", true),
    b = { ...row("b", false), proposedAction: a.proposedAction };
  expect(() => cascadeDataset([a, b])).toThrow(/conflicting/);
  const variant = row("novel", true);
  variant.attackId = data().manifest.find((c) => c.manipulated)!.family;
  expect(() => assertCascadeSplits(scores(), cascadeDataset([variant]))).toThrow(/families/);
  expect(() => assertCascadeSplits(scores(), data())).toThrow(/overlap/);
  expect(() => assertCascadeSplits(scores(), cascadeDataset([row("fresh", true)]))).not.toThrow();
});

it("never turns a test that loses a Laya-blocked attack into a production pass", () => {
  const s = scores();
  const c = s.cases.find((c) => c.manipulated)!;
  c.primary = answer(0.72);
  c.llm = answer(0.6, 0.01);
  expect(compareCascade(s, policy).gates.layaRegression).toBe(false);
});

it("stops paid scoring when cost is unknown or the cap is exceeded", async () => {
  const primary = { name: "laya", assess: async () => answer(0.1) };
  const expensive = {
    name: "llm",
    assess: async (
      _fields: unknown,
      options?: {
        onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void;
      },
    ) => {
      options?.onUsage?.({ inputTokens: 5, outputTokens: 1, costUsd: 1 });
      return answer(0.1, 1);
    },
  };
  await expect(
    scoreCascadeDataset([row("0"), row("1")], primary, expensive, identity, { maxUsd: 0.5 }),
  ).rejects.toThrow(/maxUsd/);
  const returnedUsage = { name: "llm", assess: async () => answer(0.1, 0.4) };
  await expect(
    scoreCascadeDataset([row("0"), row("1")], primary, returnedUsage, identity, { maxUsd: 0.5 }),
  ).rejects.toThrow(/maxUsd/);
  const unknown = {
    name: "llm",
    assess: async () => ({ manipulated: 0.1, model: "llm", latencyMs: 1 }),
  };
  await expect(
    scoreCascadeDataset([row("0")], primary, unknown, identity, { maxUsd: 1 }),
  ).rejects.toThrow(/report cost/);
});
