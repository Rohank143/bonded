#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  CascadeSentinel,
  DecisionModelSentinel,
  LayaSentinel,
  LlmDecisionModel,
  type SentinelModel,
} from "@bonded/demo-agents";
import { parseSentinelQuestionSet } from "@bonded/shared";
import { loadDotEnv } from "./env.js";
import { evaluateSentinel } from "./sentinel-eval.js";
import { readSeedRows } from "./synthetic.js";

const USAGE = `Usage: pnpm sentinel:eval --arena <jsonl> [--arena <jsonl> ...] (--laya <url> | --llm <model>) [options]

Scores Sentinel on held-out real Arena episodes (docs/SPECIFICATION.md Section 10.3, step 4): cases from
SENTINEL_HELD_OUT_CLASSES plus control episodes, each distinct case once.

  --arena <path>     sentinel-dataset.jsonl from \`arena rate\`; repeat for several ratings
  --laya <url>       a Laya server (services/sentinel or laya-serve); LAYA_API_KEY if it needs one
  --questions <set>  v1 (three questions, fine-tunes v1 and v2) or v3 (manipulated and injection
                     only; action risk isn't scored) (default: v1)
  --llm <model>      an OpenRouter model id, through the LLM decision model
                     (with --laya too, runs the cascade: Laya first, the LLM only when unsure)
  --out <path>       report JSON (default: datasets/sentinel-eval.json)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      arena: { type: "string", multiple: true },
      laya: { type: "string" },
      questions: { type: "string" },
      llm: { type: "string" },
      out: { type: "string", default: "datasets/sentinel-eval.json" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.arena?.length || (!values.laya && !values.llm)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  loadDotEnv();
  const laya = values.laya
    ? new LayaSentinel({
        url: values.laya.replace(/\/+$/, ""),
        questions: parseSentinelQuestionSet(values.questions),
        apiKey: process.env.LAYA_API_KEY,
        timeoutMs: 120_000,
      })
    : undefined;
  const llm = values.llm
    ? new DecisionModelSentinel(new LlmDecisionModel({ model: values.llm }))
    : undefined;
  const cascade = laya && llm ? new CascadeSentinel(laya, llm) : undefined;
  const model: SentinelModel = cascade ?? laya ?? llm!;

  const rows = values.arena.flatMap((path) => readSeedRows(path));
  console.log(`Evaluating ${model.name} on held-out cases from ${values.arena.length} rating(s)`);
  const report = await evaluateSentinel(model, rows, {
    onCase: (i, total) => {
      if (i % 10 === 0 || i === total) console.log(`  ${i}/${total}`);
    },
    ...(cascade ? { escalationRate: () => cascade.escalations / (cascade.checks || 1) } : {}),
  });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);

  if (report.errors > 0) console.error(`errors: ${report.errorMessages.join(" | ")}`);
  if (report.distinctCases === 0) {
    console.error("No held-out or control cases in the given ratings.");
    return 1;
  }
  if (report.errors === report.distinctCases) {
    console.error("Every case failed; the report has no scores.");
    return 1;
  }
  const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(100 * x).toFixed(1)}%`);
  const m = report.manipulated;
  console.log(
    `\n${report.distinctCases} distinct cases (${report.rows} rows), ${report.errors} errors`,
  );
  console.log(
    `manipulated: ${m.positives} yes / ${m.negatives} no | accuracy ${pct(m.accuracy)} | AUC ${m.auc.toFixed(3)} | TPR at ≤1% FPR ${pct(m.tprAt1pctFpr)} (FPR ${pct(m.fprAchieved)}) | ECE ${m.ece.toFixed(3)}`,
  );
  const b = report.blocking;
  console.log(
    `guard at ≥${b.threshold}: manipulated ${b.blockedManipulated} blocked / ${b.allowedManipulated} allowed | unmanipulated ${b.blockedUnmanipulated} blocked / ${b.allowedUnmanipulated} allowed`,
  );
  if (report.injection)
    console.log(
      `injection:   accuracy ${pct(report.injection.accuracy)} | AUC ${report.injection.auc.toFixed(3)} | ECE ${report.injection.ece.toFixed(3)}`,
    );
  if (report.actionRisk)
    console.log(
      `action_risk: accuracy ${pct(report.actionRisk.accuracy)} | ECE ${report.actionRisk.ece.toFixed(3)}`,
    );
  else console.log("action_risk: not asked (v3 question set)");
  for (const [g, s] of Object.entries(report.byGroup))
    console.log(
      `  ${g.padEnd(8)} ${String(s.cases).padStart(3)} cases | manipulated ${pct(s.manipulatedAccuracy)} | action_risk ${s.actionRiskAccuracy === null ? "n/a" : pct(s.actionRiskAccuracy)} | guard blocks ${s.blocking.blockedManipulated} manipulated / ${s.blocking.blockedUnmanipulated} unmanipulated`,
    );
  console.log(
    `latency p50 ${report.latencyMs.p50.toFixed(0)} ms, p95 ${report.latencyMs.p95.toFixed(0)} ms`,
  );
  if (report.pathLatencyMs) {
    const { primary, fallback } = report.pathLatencyMs;
    console.log(
      `  primary p50 ${primary.p50.toFixed(0)} ms, p95 ${primary.p95.toFixed(0)} ms | fallback (${fallback.cases} escalated) p50 ${fallback.p50.toFixed(0)} ms, p95 ${fallback.p95.toFixed(0)} ms`,
    );
  }
  if (report.escalationRate !== undefined)
    console.log(`escalated to the LLM: ${pct(report.escalationRate)}`);
  for (const note of report.notes) console.log(`note: ${note}`);
  console.log(`report: ${values.out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
