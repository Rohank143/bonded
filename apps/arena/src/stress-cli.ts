#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { LayaSentinel } from "@bonded/demo-agents";
import { loadDotEnv } from "./env.js";
import { buildStressSuite, OUT_OF_SCOPE, type StressCase } from "./stress.js";
import { evaluateStress } from "./stress-eval.js";

const USAGE = `Usage: pnpm sentinel:stress [--laya <url>] [options]

Builds the Sentinel stress suite (apps/arena/src/stress.ts) and, with --laya, scores a Laya
server on it: the guard's block decision at its threshold, the action-risk answer and the
injection answer, per family, category and split.

  --laya <url>        a Laya server (services/sentinel); LAYA_API_KEY if it needs one
  --split <which>     pool, locked or all (default: all)
  --variants <n>      cases per family (default: 12)
  --write-suite <p>   also write the cases as JSONL (sentinel-dataset format plus family fields)
  --out <path>        report JSON (default: datasets/sentinel-stress.json)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      laya: { type: "string" },
      split: { type: "string", default: "all" },
      variants: { type: "string", default: "12" },
      "write-suite": { type: "string" },
      out: { type: "string", default: "datasets/sentinel-stress.json" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || (!values.laya && !values["write-suite"])) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const variants = Number(values.variants);
  if (!Number.isInteger(variants) || variants < 1)
    throw new Error("--variants must be a whole number");
  if (!["pool", "locked", "all"].includes(values.split))
    throw new Error("--split must be pool, locked or all");
  const suite = buildStressSuite({ variants }).filter(
    (c) => values.split === "all" || c.split === values.split,
  );
  console.log(`${suite.length} cases from ${new Set(suite.map((c) => c.family)).size} families`);
  const suiteJsonl = suite.map((c) => `${JSON.stringify(c)}\n`).join("");
  if (values["write-suite"]) {
    mkdirSync(dirname(values["write-suite"]), { recursive: true });
    writeFileSync(values["write-suite"], suiteJsonl);
    console.log(`suite: ${values["write-suite"]}`);
  }
  if (!values.laya) return 0;

  loadDotEnv();
  const model = new LayaSentinel({
    url: values.laya.replace(/\/+$/, ""),
    apiKey: process.env.LAYA_API_KEY,
    timeoutMs: 120_000,
  });
  const report = await evaluateStress(model, suite as StressCase[], {
    onCase: (i, n) => {
      if (i % 50 === 0 || i === n) console.log(`  ${i}/${n}`);
    },
  });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(
    values.out,
    `${JSON.stringify({ ...report, suite: { sha256: createHash("sha256").update(suiteJsonl).digest("hex"), variants, seed: 20260930 }, outOfScope: OUT_OF_SCOPE }, null, 2)}\n`,
  );

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");
  const line = (name: string, s: (typeof report)["total"]) =>
    `${name.padEnd(28)} ${String(s.cases).padStart(4)} | guard right ${pct(s.blockCorrect, s.cases).padStart(4)} (missed ${s.missedAttacks}, false blocks ${s.falseBlocks}, breach blocks ${s.breachBlocks}) | risk ${pct(s.riskCorrect, s.cases).padStart(4)} | injection ${pct(s.injectionCorrect, s.cases).padStart(4)}${s.errors ? ` | ${s.errors} errors` : ""}`;
  console.log(`\n${report.model}, guard threshold ${report.threshold}`);
  console.log(line("total", report.total));
  for (const [k, s] of Object.entries(report.bySplit)) console.log(line(`split ${k}`, s));
  for (const [k, s] of Object.entries(report.byCategory)) console.log(line(k, s));
  console.log("");
  for (const [k, s] of Object.entries(report.byFamily)) console.log(line(k, s));
  console.log(`\n${report.failures.length} failing cases; report: ${values.out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
