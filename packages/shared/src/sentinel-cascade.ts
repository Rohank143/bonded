import { z } from "zod";
import { canonicalHash } from "./canonical.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const probability = z.number().finite().min(0).max(1);

/** Frozen before the final evaluation; never contains a provider credential or attack text. */
export const sentinelCascadePolicySchema = z.strictObject({
  version: z.literal(1),
  promptVersion: z.literal(1),
  primary: z.strictObject({
    repo: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    questions: z.literal("v3"),
  }),
  fallback: z.strictObject({
    model: z.string().min(1),
    baseUrl: z.url().refine((s) => {
      const u = new URL(s);
      return !u.username && !u.password && !u.search && !u.hash;
    }),
    questions: z.literal("v1"),
  }),
  unsureBand: z.tuple([probability, probability]).refine(([lo, hi]) => lo < hi),
  minRiskConfidence: probability,
  blockThreshold: z.literal(0.7),
  calibrationHash: hash,
  testHash: hash,
  frozenAt: z.iso.datetime(),
  protocol: z.strictObject({
    maxTprDrop: probability,
    minBenignCases: z.number().int().min(100),
    hostingUsdPer1000: z.number().finite().nonnegative().nullable(),
  }),
});
export type SentinelCascadePolicy = z.infer<typeof sentinelCascadePolicySchema>;
export const sentinelCascadePolicyHash = (policy: SentinelCascadePolicy) =>
  canonicalHash(JSON.stringify(sentinelCascadePolicySchema.parse(policy)));

/** Public aggregate evidence. Individual held-out states and answers stay in private datasets. */
export const sentinelCascadeEvidenceSchema = z.object({
  version: z.literal(1),
  policyHash: hash,
  testHash: hash,
  evaluatedAt: z.iso.datetime(),
  pass: z.boolean(),
  gates: z.strictObject({
    detection: z.boolean(),
    productionFpr: z.boolean(),
    layaRegression: z.boolean(),
    sufficientCases: z.boolean(),
    noErrors: z.boolean(),
    knownCost: z.boolean(),
    cheaperThanLlm: z.boolean(),
  }),
});

/** Require the exact frozen policy and test set, with every gate explicitly passing. */
export function verifySentinelCascadeEvidence(policy: SentinelCascadePolicy, input: unknown) {
  const evidence = sentinelCascadeEvidenceSchema.parse(input);
  if (
    evidence.policyHash !== sentinelCascadePolicyHash(policy) ||
    evidence.testHash !== policy.testHash
  )
    throw new Error("cascade evaluation belongs to a different policy or test dataset");
  if (Date.parse(evidence.evaluatedAt) < Date.parse(policy.frozenAt))
    throw new Error("cascade policy must be frozen before its test evaluation");
  if (!evidence.pass || !Object.values(evidence.gates).every(Boolean))
    throw new Error("cascade evaluation did not pass every production gate");
  return evidence;
}
