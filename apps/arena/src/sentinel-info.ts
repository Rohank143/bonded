import { DEFAULT_CASCADE_UNSURE_BAND, DEFAULT_SENTINEL_BLOCK_THRESHOLD } from "@bonded/demo-agents";
import { parseSentinelQuestionSet } from "@bonded/shared";
import type { RatingSentinel } from "./rate.js";
import { cascadePolicyInfo } from "./sentinel-policy.js";

/**
 * What a report records about the guard `sentinelModel` builds from the same flags: an LLM
 * guard asks the v1 questions; Laya asks the chosen set; a cascade adds its fallback, which as
 * an LLM asks the v1 questions, and the band that escalates to it.
 */
export function sentinelInfo(
  spec: string,
  fallback?: string,
  questions?: string,
  policy?: string,
): RatingSentinel {
  if (policy) return cascadePolicyInfo(policy);
  const base = { blockThreshold: DEFAULT_SENTINEL_BLOCK_THRESHOLD };
  if (!spec.startsWith("laya:")) return { ...base, model: spec, questions: "v1" };
  return {
    ...base,
    model: "laya/typed-decisions",
    questions: parseSentinelQuestionSet(questions),
    ...(fallback
      ? { fallback: { model: fallback, questions: "v1", unsureBand: DEFAULT_CASCADE_UNSURE_BAND } }
      : {}),
  };
}
