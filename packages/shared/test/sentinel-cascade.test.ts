import { expect, it } from "vitest";
import {
  sentinelCascadePolicyHash,
  sentinelCascadePolicySchema,
  verifySentinelCascadeEvidence,
} from "../src/sentinel-cascade.js";

const policy = sentinelCascadePolicySchema.parse({
  version: 1,
  promptVersion: 1,
  primary: { repo: "owner/model", revision: "a".repeat(40), questions: "v3" },
  fallback: { model: "model", baseUrl: "https://example.test/v1", questions: "v1" },
  unsureBand: [0.2, 0.8],
  minRiskConfidence: 0.6,
  blockThreshold: 0.7,
  calibrationHash: `0x${"1".repeat(64)}`,
  testHash: `0x${"2".repeat(64)}`,
  frozenAt: "2026-10-08T00:00:00.000Z",
  protocol: { maxTprDrop: 0, minBenignCases: 300, hostingUsdPer1000: null },
});
const evidence = () => ({
  version: 1,
  policyHash: sentinelCascadePolicyHash(policy),
  testHash: policy.testHash,
  evaluatedAt: "2026-10-08T00:01:00.000Z",
  pass: true,
  gates: {
    detection: true,
    productionFpr: true,
    layaRegression: true,
    sufficientCases: true,
    noErrors: true,
    knownCost: true,
    cheaperThanLlm: true,
  },
});

it("hashes fractional policy values and rejects uncalibrated or invalid configuration", () => {
  expect(sentinelCascadePolicyHash(policy)).toMatch(/^0x[0-9a-f]{64}$/);
  expect(sentinelCascadePolicyHash({ ...policy, unsureBand: [0.25, 0.8] })).not.toBe(
    sentinelCascadePolicyHash(policy),
  );
  expect(() => sentinelCascadePolicySchema.parse({ ...policy, unsureBand: [0.8, 0.2] })).toThrow();
  expect(() =>
    sentinelCascadePolicySchema.parse({
      ...policy,
      fallback: { ...policy.fallback, baseUrl: "https://secret@example.test" },
    }),
  ).toThrow();
});

it("requires matching, later evidence with every explicit gate passing", () => {
  expect(verifySentinelCascadeEvidence(policy, evidence()).pass).toBe(true);
  expect(() =>
    verifySentinelCascadeEvidence(policy, { ...evidence(), testHash: policy.calibrationHash }),
  ).toThrow(/different/);
  expect(() =>
    verifySentinelCascadeEvidence({ ...policy, unsureBand: [0.3, 0.8] }, evidence()),
  ).toThrow(/different/);
  expect(() =>
    verifySentinelCascadeEvidence(policy, {
      ...evidence(),
      evaluatedAt: "2026-10-07T00:00:00.000Z",
    }),
  ).toThrow(/frozen/);
  expect(() =>
    verifySentinelCascadeEvidence(policy, {
      ...evidence(),
      gates: { ...evidence().gates, knownCost: false },
    }),
  ).toThrow(/every/);
});
