import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { sentinelCascadePolicyHash, sentinelCascadePolicySchema } from "@bondedhq/shared";
import { sentinelFromEnv, sentinelCodeHash } from "../src/sentinel.js";
import { ratedCodeHash } from "../src/worker.js";

const directory = mkdtempSync(join(tmpdir(), "bonded-cascade-config-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const policy = sentinelCascadePolicySchema.parse({
  version: 1,
  promptVersion: 1,
  primary: { repo: "owner/model", revision: "a".repeat(40), questions: "v3" },
  fallback: { model: "fallback", baseUrl: "https://example.test/v1", questions: "v1" },
  unsureBand: [0.2, 0.8],
  minRiskConfidence: 0.6,
  blockThreshold: 0.7,
  calibrationHash: `0x${"1".repeat(64)}`,
  testHash: `0x${"2".repeat(64)}`,
  frozenAt: "2026-10-08T00:00:00.000Z",
  protocol: { maxTprDrop: 0, minBenignCases: 300, hostingUsdPer1000: null },
});
const evidence = {
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
};
const file = (name: string, value: unknown) => {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const env = {
  SENTINEL_MODE: "cascade",
  SENTINEL_URL: "https://sentinel.test",
  SENTINEL_MODEL_REPO: policy.primary.repo,
  SENTINEL_MODEL_REVISION: policy.primary.revision,
  LLM_API_KEY: "test-only",
  LLM_BASE_URL: policy.fallback.baseUrl,
  SENTINEL_CASCADE_POLICY_FILE: file("policy.json", policy),
  SENTINEL_CASCADE_EVALUATION_FILE: file("evaluation.json", evidence),
};

it("builds the evaluated cascade and keeps rollback and old Laya hashes compatible", () => {
  const service = sentinelFromEnv(env)!;
  expect(service.model.name).toBe("cascade/laya/typed-decisions+llm/fallback");
  expect(service.info).toMatchObject({
    pipelineHash: evidence.policyHash,
    fallback: { model: "fallback", unsureBand: [0.2, 0.8] },
  });
  const codeHash = `0x${"a".repeat(64)}` as const;
  expect(ratedCodeHash({ codeHash, sentinel: true }, service)).not.toBe(sentinelCodeHash(codeHash));
  expect(ratedCodeHash({ codeHash }, service)).toBe(codeHash);
  const rollback = sentinelFromEnv({ ...env, SENTINEL_MODE: "laya" })!;
  expect(rollback.model.name).toBe("laya/typed-decisions");
  expect(ratedCodeHash({ codeHash, sentinel: true }, rollback)).toBe(sentinelCodeHash(codeHash));
});

it("refuses partial configuration, wrong checkpoints and failing evidence", () => {
  expect(() => sentinelFromEnv({ SENTINEL_MODE: "cascade" })).toThrow(/SENTINEL_URL/);
  expect(() => sentinelFromEnv({ SENTINEL_MODE: "typo" })).toThrow();
  expect(() => sentinelFromEnv({ ...env, SENTINEL_CASCADE_EVALUATION_FILE: undefined })).toThrow(
    /evaluation/,
  );
  expect(() => sentinelFromEnv({ ...env, SENTINEL_MODEL_REVISION: "b".repeat(40) })).toThrow(
    /checkpoint/,
  );
  expect(() =>
    sentinelFromEnv({
      ...env,
      SENTINEL_CASCADE_EVALUATION_FILE: file("failed.json", { ...evidence, pass: false }),
    }),
  ).toThrow(/gate/);
});
