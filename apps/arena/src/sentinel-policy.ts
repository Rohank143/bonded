import { readFileSync } from "node:fs";
import {
  CascadeSentinel,
  DecisionModelSentinel,
  LayaSentinel,
  LlmDecisionModel,
} from "@bonded/demo-agents";
import {
  llmConfigFromEnv,
  OpenAICompatibleClient,
  sentinelCascadePolicySchema,
  sentinelCascadePolicyHash,
} from "@bonded/shared";
import type { RatingSentinel } from "./rate.js";

/** Candidate policies can be tested here before passing evidence is available for production. */
export function cascadePolicyInfo(path: string): RatingSentinel {
  const p = sentinelCascadePolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return {
    model: "laya/typed-decisions",
    repo: p.primary.repo,
    revision: p.primary.revision,
    questions: p.primary.questions,
    blockThreshold: p.blockThreshold,
    pipelineHash: sentinelCascadePolicyHash(p),
    fallback: {
      model: p.fallback.model,
      questions: p.fallback.questions,
      unsureBand: p.unsureBand,
      minRiskConfidence: p.minRiskConfidence,
    },
  };
}

export function cascadeFromPolicy(url: string, path: string) {
  const p = sentinelCascadePolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const config = llmConfigFromEnv();
  if (config.baseUrl !== p.fallback.baseUrl.replace(/\/+$/, ""))
    throw new Error("LLM endpoint differs from the frozen policy");
  const laya = new LayaSentinel({ url, apiKey: process.env.LAYA_API_KEY, questions: "v3" });
  let checkedAt = -Infinity;
  const primary = {
    name: laya.name,
    get usage() {
      return laya.usage;
    },
    async assess(...args: Parameters<LayaSentinel["assess"]>) {
      const started = performance.now();
      if (Date.now() - checkedAt >= 30_000) {
        const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok || !(await health.text()).includes(p.primary.revision))
          throw new Error("Laya health does not confirm the frozen revision");
        checkedAt = Date.now();
      }
      args[1]?.signal?.throwIfAborted();
      const answer = await laya.assess(...args);
      return { ...answer, latencyMs: performance.now() - started };
    },
  };
  const cascade = new CascadeSentinel(
    primary,
    new DecisionModelSentinel(
      new LlmDecisionModel({ model: p.fallback.model, client: new OpenAICompatibleClient(config) }),
    ),
    { unsureBand: p.unsureBand, minRiskConfidence: p.minRiskConfidence },
  );
  return {
    name: cascade.name,
    get usage() {
      return cascade.usage;
    },
    assess: (
      fields: Parameters<CascadeSentinel["assess"]>[0],
      options?: Parameters<CascadeSentinel["assess"]>[1],
    ) =>
      cascade.assess(fields, {
        ...options,
        signal: options?.signal ?? AbortSignal.timeout(20_000),
      }),
  };
}
