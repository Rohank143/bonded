#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LayaSentinel } from "@bonded/demo-agents";
import { parseSentinelQuestionSet } from "@bonded/shared";
import { type ConsistencyCase, distinctCases, evaluateConsistency } from "./consistency.js";
import { loadDotEnv } from "./env.js";
import { buildStressSuite } from "./stress.js";
import { readSeedRows } from "./synthetic.js";

const USAGE = `Usage: pnpm sentinel:consistency --laya <url> [--arena <jsonl> ...] [options]

Gate 5 (src/consistency.ts): runs a Laya Sentinel on each case, then again after edits that
can't change the right answer, and reports how often the block decision changes.

  --laya <url>        a Laya server; LAYA_API_KEY if it needs one
  --questions <set>   v1 or v3 (default: v1)
  --arena <path>      sentinel-dataset.jsonl rows to test (repeatable; distinct cases only)
  --stress <split>    also the stress suite's cases from this split: locked, pool or all
                      (default: locked; "none" to skip)
  --out <path>        report JSON (default: datasets/consistency.json)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      laya: { type: "string" },
      questions: { type: "string" },
      arena: { type: "string", multiple: true },
      stress: { type: "string", default: "locked" },
      out: { type: "string", default: "datasets/consistency.json" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.laya) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  loadDotEnv();
  const model = new LayaSentinel({
    url: values.laya.replace(/\/+$/, ""),
    questions: parseSentinelQuestionSet(values.questions),
    apiKey: process.env.LAYA_API_KEY,
    timeoutMs: 120_000,
  });
  const stress: ConsistencyCase[] =
    values.stress === "none"
      ? []
      : buildStressSuite()
          .filter((c) => values.stress === "all" || c.split === values.stress)
          .map((c) => ({
            id: c.id,
            mandate: c.mandate,
            proposedAction: c.proposedAction as ConsistencyCase["proposedAction"],
            untrustedInputs: c.untrustedInputs,
          }));
  const arena = distinctCases(
    (values.arena ?? []).flatMap((path) => readSeedRows(path)) as ConsistencyCase[],
  );
  const cases = [...stress, ...arena];
  const report = await evaluateConsistency(model, cases, {
    name: values.laya,
    onCase: (i, n) => {
      if (i % 50 === 0) process.stderr.write(`  ${i}/${n}\n`);
    },
  });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `consistency: ${report.cases} cases (${stress.length} stress, ${arena.length} Arena), ${report.runs} edited runs, decision changed in ${report.flips} (${(report.flipRate * 100).toFixed(1)}%), errors ${report.errors}`,
  );
  for (const e of report.edits)
    console.log(`  ${e.edit.padEnd(16)} ${String(e.flips).padStart(3)} of ${e.cases}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
