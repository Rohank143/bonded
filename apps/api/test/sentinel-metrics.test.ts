import { afterAll, beforeAll, expect, it } from "vitest";
import { Database } from "@bonded/db";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
beforeAll(async () => {
  pg = await postgres();
}, 60_000);
afterAll(async () => {
  await pg?.stop();
});

it("persists path timing and isolates pipelines, retaining unknown legacy and error cost", async () => {
  const since = new Date(0);
  await pg.db.recordSentinelCheck(1, "1", { manipulated: 0.1, blocked: false, latencyMs: 10 });
  const success = {
    pipelineHash: "pipeline-a",
    manipulated: 0.1,
    blocked: false,
    latencyMs: 30,
    escalated: true,
    primaryLatencyMs: 10,
    fallbackLatencyMs: 20,
    inputTokens: 7,
    outputTokens: 2,
    llmCostUsd: 0.002,
  };
  await pg.db.recordSentinelCheck(1, "1", success);
  await pg.db.recordSentinelCheck(1, "1", {
    ...success,
    pipelineHash: "pipeline-b",
    llmCostUsd: 0.5,
  });
  const reconnect = new Database(pg.url);
  try {
    expect(await reconnect.sentinelMetrics(1, since, "pipeline-a")).toMatchObject({
      checks: 1,
      errors: 0,
      escalations: 1,
      escalationRate: 1,
      llmCostUsd: 0.002,
      llmUsdPer1000: 2,
      primaryLatencyMs: { p50: 10, p95: 10 },
      fallbackLatencyMs: { p50: 20, p95: 20 },
      inputTokens: 7,
    });
    await reconnect.recordSentinelCheck(1, "1", {
      pipelineHash: "pipeline-a",
      status: "error",
      manipulated: null,
      blocked: null,
      latencyMs: 100,
      escalated: true,
      primaryLatencyMs: 10,
      fallbackLatencyMs: 90,
    });
    expect(await reconnect.sentinelMetrics(1, since, "pipeline-a")).toMatchObject({
      checks: 2,
      errors: 1,
      escalations: 2,
      knownCostChecks: 1,
      llmCostUsd: null,
      llmUsdPer1000: null,
    });
    expect(await reconnect.sentinelCheckCounts(1, since)).toMatchObject({ checks: 4, blocked: 0 });
    expect(await reconnect.sentinelMetrics(1, since, "empty")).toMatchObject({
      checks: 0,
      escalationRate: null,
      llmUsdPer1000: null,
    });
    const legacy = (
      await reconnect.pool.query(
        "SELECT escalated, llm_cost_usd FROM sentinel_checks WHERE pipeline_hash IS NULL",
      )
    ).rows[0];
    expect(legacy).toEqual({ escalated: null, llm_cost_usd: null });
  } finally {
    await reconnect.close();
  }
});
