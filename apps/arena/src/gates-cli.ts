#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { arenaOutcome, decideGates } from "./gates.js";

const USAGE = `Usage: node dist/gates-cli.js --dir <gates output dir>

Reads the reports scripts/sentinel-gates.sh wrote in <dir> (baseline-*.json, candidate-*.json
and the two Arena ratings) and decides each production gate (src/gates.ts). Writes
<dir>/verdict.json and exits 0 only if every gate passes.`;

function main(): number {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, help: { type: "boolean", default: false } },
  });
  if (values.help || !values.dir) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const dir = values.dir;
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const pair = (kind: string) => ({
    baseline: read(`baseline-${kind}.json`),
    candidate: read(`candidate-${kind}.json`),
  });
  const verdict = decideGates({
    heldOut: pair("heldout"),
    stress: pair("stress-locked"),
    benign: pair("benign"),
    arena: {
      baseline: arenaOutcome(join(dir, "arena-baseline", "traces")),
      candidate: arenaOutcome(join(dir, "arena-candidate", "traces")),
    },
  });
  writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  for (const g of verdict.gates) {
    console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.gate}`);
    for (const d of g.details) console.log(`      ${d}`);
  }
  console.log(
    verdict.pass
      ? "\nAll gates pass: the candidate may replace the baseline."
      : "\nNot promoted: at least one gate failed.",
  );
  return verdict.pass ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
