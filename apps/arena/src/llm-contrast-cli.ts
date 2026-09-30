#!/usr/bin/env node
import { parseArgs } from "node:util";
import { llmConfigFromEnv, OpenAICompatibleClient } from "@bonded/shared";
import { loadDotEnv } from "./env.js";
import { generateLlmContrast } from "./llm-contrast.js";

const USAGE = `Usage: pnpm sentinel:contrast --count <n> --max-usd <n> [options]

Writes v3 contrastive training pairs whose planted inputs an LLM writes (llm-contrast.ts).
Labels, orders and independent trades come from code. Needs OPENROUTER_API_KEY in .env.

  --count <n>        scenes (two rows each), counting ones already in --out (required)
  --max-usd <n>      stop once model spend reaches this (required)
  --model <id>       any OpenRouter model id (default: deepseek/deepseek-v4.1-flash)
  --out <path>       JSONL, appended; rerun to resume (default: datasets/sentinel-contrast-llm.jsonl)
  --concurrency <n>  parallel requests (default: 6)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      count: { type: "string" },
      "max-usd": { type: "string" },
      model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      out: { type: "string", default: "datasets/sentinel-contrast-llm.jsonl" },
      concurrency: { type: "string", default: "6" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.count || !values["max-usd"]) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const count = Number(values.count);
  const maxUsd = Number(values["max-usd"]);
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a whole number");
  if (!(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  loadDotEnv();
  const summary = await generateLlmContrast({
    client: new OpenAICompatibleClient(llmConfigFromEnv()),
    model: values.model,
    count,
    maxUsd,
    out: values.out,
    concurrency: Number(values.concurrency),
    onRow: (n) => {
      if (n % 100 === 0) console.log(`  ${n} pairs`);
    },
  });
  console.log(
    `\nWrote ${summary.written} pairs; ${summary.skippedExisting} already present; stopped by ${summary.stoppedBy}`,
  );
  console.log(`Rejected: ${JSON.stringify(summary.rejected)}`);
  console.log(`Spend: $${summary.spend.spentUsd.toFixed(4)} of $${maxUsd}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
