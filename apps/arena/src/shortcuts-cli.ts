#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditRowFromLaya, auditShortcuts, formatAudit } from "./shortcuts.js";

const USAGE = `Usage: pnpm sentinel:shortcuts <dataset dir>

Checks a built Laya dataset (its train.jsonl) for surface features that predict the
"manipulated" label (see src/shortcuts.ts). Exits 1 if one does: don't train on it.`;

function main(): number {
  const dir = process.argv[2];
  if (!dir || dir === "--help") {
    console.log(USAGE);
    return dir ? 0 : 1;
  }
  const rows = readFileSync(join(dir, "train.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => auditRowFromLaya(JSON.parse(line) as Parameters<typeof auditRowFromLaya>[0]));
  const audit = auditShortcuts(rows);
  console.log(formatAudit(audit));
  return audit.pass ? 0 : 1;
}

process.exit(main());
