#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  ATTACK_CLASSES,
  OpenAICompatibleClient,
  SENTINEL_HELD_OUT_CLASSES,
  llmConfigFromEnv,
} from "@bonded/shared";
import { loadDotEnv } from "./env.js";
import { generateSynthetic, readSeedRows, TARGET_SETS, type TargetSet } from "./synthetic.js";

const USAGE = `Usage: pnpm sentinel:synth --seeds <jsonl> --max-usd <n> [options]

Writes synthetic Sentinel training rows (docs/PLAN.md Section 10.3) seeded from real Arena rows.
Needs OPENROUTER_API_KEY (or LLM_API_KEY with LLM_BASE_URL) in .env.

  --seeds <path>            sentinel-dataset.jsonl written by \`arena rate\` (required)
  --max-usd <n>             stop once model spend reaches this (required)
  --count <n>               rows to produce, counting rows already in --out (default: 300)
  --model <id>              any OpenRouter model id (default: deepseek/deepseek-v4.1-flash)
  --out <path>              JSONL output, appended; rerun to resume (default: datasets/sentinel-synthetic.jsonl)
  --exclude-classes <ids>   attack classes to keep out for held-out evaluation, comma-separated,
                            or "none" (default: SENTINEL_HELD_OUT_CLASSES, ${SENTINEL_HELD_OUT_CLASSES.join(",")})
  --targets <default|sells> kinds of example: the balanced mix, or sells and small trades (v2)
                            (default: default)
  --concurrency <n>         parallel requests (default: 4)
  --reasoning <on|off>      let a reasoning model think first; off is cheaper and avoids empty answers (default: off)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      seeds: { type: "string" },
      "max-usd": { type: "string" },
      count: { type: "string", default: "300" },
      model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      out: { type: "string", default: "datasets/sentinel-synthetic.jsonl" },
      "exclude-classes": { type: "string", default: SENTINEL_HELD_OUT_CLASSES.join(",") },
      targets: { type: "string", default: "default" },
      concurrency: { type: "string", default: "4" },
      reasoning: { type: "string", default: "off" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.seeds || !values["max-usd"]) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const maxUsd = Number(values["max-usd"]);
  const count = Number(values.count);
  const concurrency = Number(values.concurrency);
  if (!(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a whole number");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("--concurrency must be 1 to 16");
  if (!(values.targets in TARGET_SETS)) throw new Error("--targets must be default or sells");
  if (values.reasoning !== "on" && values.reasoning !== "off")
    throw new Error("--reasoning must be on or off");

  loadDotEnv();
  const client = new OpenAICompatibleClient(llmConfigFromEnv());
  const classNames = Object.fromEntries(
    Object.entries(ATTACK_CLASSES).map(([id, info]) => [id, `${info.name}: ${info.description}`]),
  );
  const excluded = values["exclude-classes"] === "none" ? "" : values["exclude-classes"];
  const excludeClasses = excluded
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  console.log(`Model ${values.model}; up to ${count} rows into ${values.out}; cap $${maxUsd}`);
  if (excludeClasses.length) console.log(`Held out: ${excludeClasses.join(", ")}`);

  const summary = await generateSynthetic({
    client,
    model: values.model,
    seeds: readSeedRows(values.seeds),
    count,
    maxUsd,
    out: values.out,
    excludeClasses,
    targets: values.targets as TargetSet,
    classNames,
    concurrency,
    reasoning: values.reasoning === "on",
    onRow: (row, n) => {
      if (n % 25 === 0) console.log(`  ${n} rows (latest ${row.generator.target})`);
    },
    onReject: (reason, detail) => console.log(`  rejected (${reason}): ${detail.split("\n")[0]}`),
  });
  console.log(`\nWrote ${summary.written} rows; ${summary.skippedExisting} already present.`);
  console.log(`By target: ${JSON.stringify(summary.byTarget)}`);
  console.log(`Rejected: ${JSON.stringify(summary.rejected)}`);
  const s = summary.spend;
  console.log(
    `Spend: $${s.spentUsd.toFixed(4)}${s.estimated ? " (estimated)" : ""} of $${s.maxUsd}; ${s.inputTokens} input + ${s.outputTokens} output tokens`,
  );
  if (summary.stoppedBy !== "count") console.log(`Stopped early: ${summary.stoppedBy}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
