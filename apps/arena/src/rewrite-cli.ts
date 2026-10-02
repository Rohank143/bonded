#!/usr/bin/env node
import { parseArgs } from "node:util";
import { llmConfigFromEnv, OpenAICompatibleClient } from "@bonded/shared";
import { buildContrastRows } from "./contrast.js";
import { loadDotEnv } from "./env.js";
import { rewriteRows } from "./rewrite.js";

const USAGE = `Usage: pnpm sentinel:rewrite --max-usd <n> [options]

Has a model reword the text of the rule-built contrastive rows (src/rewrite.ts). Code checks
each rewrite and keeps the original unless the numbers, addresses, symbols, orders and shape
are unchanged. Labels never change. Needs OPENROUTER_API_KEY in .env.

  --max-usd <n>      stop once model spend reaches this (required)
  --model <id>       any OpenRouter model id (default: deepseek/deepseek-v4.1-flash)
  --out <path>       JSONL, appended; rerun to resume (default: datasets/contrast-rewrites.jsonl)
  --concurrency <n>  parallel requests (default: 8)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      out: { type: "string", default: "datasets/contrast-rewrites.jsonl" },
      concurrency: { type: "string", default: "8" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  if (values.help || !(maxUsd > 0)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("--concurrency must be a whole number of 1 or more");
  loadDotEnv();
  const summary = await rewriteRows({
    client: new OpenAICompatibleClient(llmConfigFromEnv()),
    model: values.model,
    rows: buildContrastRows(),
    maxUsd,
    out: values.out,
    concurrency,
    onDone: (n) => {
      if (n % 250 === 0) console.log(`  ${n} rewritten`);
    },
  });
  console.log(
    `\nWrote ${summary.written}; ${summary.skippedExisting} already present; stopped by ${summary.stoppedBy}`,
  );
  console.log(
    `Inputs reworded: ${summary.rewritten} of ${summary.inputs}; kept as they were: ${JSON.stringify(summary.kept)}; failed requests: ${summary.failed}`,
  );
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
