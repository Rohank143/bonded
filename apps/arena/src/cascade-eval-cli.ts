#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DecisionModelSentinel, LayaSentinel, LlmDecisionModel } from "@bonded/demo-agents";
import {
  llmConfigFromEnv,
  OpenAICompatibleClient,
  sentinelCascadePolicySchema,
  sentinelCascadePolicyHash,
  type SentinelCascadePolicy,
} from "@bondedhq/shared";
import { loadDotEnv } from "./env.js";
import { readSeedRows } from "./synthetic.js";
import {
  assertCascadeSplits,
  calibrateCascade,
  cascadeDataset,
  cascadeScoresSchema,
  compareCascade,
  scoreCascadeDataset,
} from "./cascade-eval.js";

const USAGE = `Usage: pnpm sentinel:cascade <score|calibrate|test> [options]

score: --arena <jsonl> (repeatable) --laya <url> --revision <40-char SHA>
       --repo <Hugging Face repo> --llm <model> --out <private-scores.json> --max-usd <cap>
calibrate: --scores <calibration-scores.json> --arena <final-test.jsonl> (repeatable)
           --out <frozen-policy.json> [--max-tpr-drop 0] [--min-benign 300]
           [--hosting-usd-per-1000 <assumed allocated hosting cost>]
test: --policy <frozen-policy.json> --arena <final-test.jsonl> (repeatable)
      --laya <url> --out <aggregate-report.json> --max-usd <cap>

The band is chosen only from calibration scores. Final test inputs and families must be
disjoint, and the final dataset hash is frozen in the policy before scoring. Existing output
files are never overwritten. A failed final test exits nonzero. Scores contain private labels;
keep them under ignored datasets/. Only the aggregate test report is suitable for publication.`;

function read(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
}
async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      arena: { type: "string", multiple: true },
      laya: { type: "string" },
      llm: { type: "string" },
      repo: { type: "string" },
      revision: { type: "string" },
      out: { type: "string" },
      scores: { type: "string" },
      policy: { type: "string" },
      "max-usd": { type: "string" },
      "max-tpr-drop": { type: "string", default: "0" },
      "min-benign": { type: "string", default: "300" },
      "hosting-usd-per-1000": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !["score", "calibrate", "test"].includes(command ?? "")) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!values.arena?.length || !values.out) throw new Error("--arena and --out are required");
  const outputs = [
    values.out,
    `${values.out}.calibration.json`,
    `${values.out}.private-scores.json`,
  ];
  if (outputs.some(existsSync))
    throw new Error("output already exists; use a new run path before scoring");
  const rows = values.arena.flatMap(readSeedRows);
  const dataset = cascadeDataset(rows);
  if (!dataset.cases.length) throw new Error("no distinct held-out or control inputs");
  loadDotEnv();
  if (command === "calibrate") {
    if (!values.scores) throw new Error("--scores is required");
    const scores = cascadeScoresSchema.parse(read(values.scores));
    assertCascadeSplits(scores, dataset);
    const protocol = sentinelCascadePolicySchema.shape.protocol.parse({
      maxTprDrop: Number(values["max-tpr-drop"]),
      minBenignCases: Number(values["min-benign"]),
      hostingUsdPer1000:
        values["hosting-usd-per-1000"] === undefined
          ? null
          : Number(values["hosting-usd-per-1000"]),
    });
    if (
      dataset.cases.filter((c) => !c.manipulated).length < protocol.minBenignCases ||
      !dataset.cases.some((c) => c.manipulated)
    )
      throw new Error(
        "final dataset needs enough distinct negatives and at least one positive before freezing",
      );
    const selected = calibrateCascade(scores, protocol);
    const policy = sentinelCascadePolicySchema.parse({
      version: 1,
      promptVersion: 1,
      primary: scores.primary,
      fallback: scores.fallback,
      ...selected.options,
      calibrationHash: scores.datasetHash,
      testHash: dataset.hash,
      frozenAt: new Date().toISOString(),
    });
    save(values.out, policy);
    save(`${values.out}.calibration.json`, selected.comparison);
    console.log(
      `Frozen band ${policy.unsureBand.join("–")}; policy ${sentinelCascadePolicyHash(policy)}`,
    );
    return 0;
  }
  if (!values.laya) throw new Error("--laya is required");
  const policy: SentinelCascadePolicy | undefined =
    command === "test" ? sentinelCascadePolicySchema.parse(read(values.policy ?? "")) : undefined;
  if (policy && dataset.hash !== policy.testHash)
    throw new Error("final dataset differs from the frozen policy");
  const identity = policy
    ? { primary: policy.primary, fallback: policy.fallback }
    : {
        primary: sentinelCascadePolicySchema.shape.primary.parse({
          repo: values.repo,
          revision: values.revision,
          questions: "v3",
        }),
        fallback: {
          model: values.llm ?? "",
          baseUrl: llmConfigFromEnv().baseUrl,
          questions: "v1" as const,
        },
      };
  const config = llmConfigFromEnv();
  if (!identity.fallback.model || identity.fallback.baseUrl.replace(/\/+$/, "") !== config.baseUrl)
    throw new Error("fallback model and endpoint must match the frozen identity");
  // The server's health response must name the pinned revision; never label unknown weights.
  const health = await fetch(`${values.laya.replace(/\/+$/, "")}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!health.ok || !(await health.text()).includes(identity.primary.revision))
    throw new Error("Laya health does not confirm the pinned checkpoint revision");
  const maxUsd = Number(values["max-usd"]);
  const scores = await scoreCascadeDataset(
    rows,
    new LayaSentinel({
      url: values.laya.replace(/\/+$/, ""),
      questions: "v3",
      apiKey: process.env.LAYA_API_KEY,
    }),
    new DecisionModelSentinel(
      new LlmDecisionModel({
        model: identity.fallback.model,
        client: new OpenAICompatibleClient(config),
      }),
    ),
    identity,
    {
      maxUsd,
      onCase: (i, total) => {
        if (i % 10 === 0 || i === total) console.log(`${i}/${total}`);
      },
    },
  );
  if (!policy) {
    save(values.out, scores);
    return scores.cases.some((c) => !c.primary || !c.llm) ? 1 : 0;
  }
  const comparison = compareCascade(scores, policy);
  save(`${values.out}.private-scores.json`, scores);
  const evidence = {
    version: 1,
    policyHash: sentinelCascadePolicyHash(policy),
    testHash: dataset.hash,
    evaluatedAt: new Date().toISOString(),
    ...comparison,
  };
  save(values.out, evidence);
  console.log(
    JSON.stringify({
      pass: evidence.pass,
      gates: evidence.gates,
      escalationRate: evidence.cascade.escalationRate,
      llmUsdPer1000: evidence.cascade.llmUsdPer1000,
    }),
  );
  return evidence.pass ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
