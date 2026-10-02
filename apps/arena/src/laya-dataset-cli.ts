#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseSentinelQuestionSet } from "@bonded/shared";
import {
  buildContrastRows,
  type ContrastRow,
  diversifyPairs,
  mentionOwnAmounts,
} from "./contrast.js";
import { buildLayaDataset } from "./laya-dataset.js";
import { formatAudit } from "./shortcuts.js";
import type { SyntheticRow } from "./synthetic.js";
import { readSeedRows } from "./synthetic.js";

const USAGE = `Usage: pnpm sentinel:dataset --arena <jsonl> [--arena <jsonl> ...] --synthetic <jsonl> [--out <dir>]

Builds the Laya fine-tuning set (docs/PLAN.md Section 10.3) from real Arena rows (written by
\`arena rate\`) and synthetic rows (written by \`sentinel:synth\`). Writes train.jsonl, test.jsonl
and manifest.json. Test holds only real rows from the held-out classes plus control episodes.

  --arena <path>       sentinel-dataset.jsonl from a rating; repeat for several ratings
  --synthetic <path>   synthetic rows generated with the held-out classes excluded
  --contrast           add the rule-labelled contrastive pairs (contrast.ts) to training
  --contrast-file <p>  add LLM-written contrastive pairs (sentinel:contrast output); repeatable.
                       They get the same shortcut-breaking changes as the rule-built pairs
                       (contrast.ts, diversifyPairs); 15% of the unmanipulated synthetic rows
                       get a harmless mention of their own amount (mentionOwnAmounts)
  --allow-shortcuts    write the dataset even if the shortcut audit fails (for analysis only)
  --seeds <path>       ratings used only to trace synthetic rows' seeds (repeatable)
  --exclude-ids <path> ids of rows too long for Laya's window (services/sentinel/kaggle/check_tokens.py)
  --questions <set>    v1 (three questions) or v3 (manipulated and injection) (default: v1)
  --out <dir>          output folder (default: datasets/laya)`;

function readContrastRows(path: string): ContrastRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ContrastRow);
}

function main(): number {
  const { values } = parseArgs({
    options: {
      arena: { type: "string", multiple: true },
      synthetic: { type: "string" },
      contrast: { type: "boolean", default: false },
      "contrast-file": { type: "string", multiple: true },
      seeds: { type: "string", multiple: true },
      "exclude-ids": { type: "string" },
      questions: { type: "string" },
      "allow-shortcuts": { type: "boolean", default: false },
      out: { type: "string", default: "datasets/laya" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.arena?.length || !values.synthetic) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const dataset = buildLayaDataset({
    arena: values.arena.flatMap((path) => readSeedRows(path)),
    // Harmless mentions of their own amount in 15% of the unmanipulated synthetic rows
    // (contrast.ts, mentionOwnAmounts).
    synthetic: mentionOwnAmounts(readSeedRows(values.synthetic) as unknown as SyntheticRow[]),
    contrast: [
      ...(values.contrast ? buildContrastRows() : []),
      ...diversifyPairs((values["contrast-file"] ?? []).flatMap((path) => readContrastRows(path))),
    ],
    ...(values.seeds ? { seeds: values.seeds.flatMap((path) => readSeedRows(path)) } : {}),
    ...(values["exclude-ids"]
      ? {
          excludeIds: new Set(
            readFileSync(values["exclude-ids"], "utf8")
              .split("\n")
              .filter((id) => id.trim()),
          ),
        }
      : {}),
    questions: parseSentinelQuestionSet(values.questions),
  });
  const audit = dataset.manifest.shortcuts;
  console.log(formatAudit(audit));
  if (!audit.pass && !values["allow-shortcuts"]) {
    console.error(
      "Not written: a surface rule predicts the labels. Fix the data, don't train on it.",
    );
    return 1;
  }
  mkdirSync(values.out, { recursive: true });
  const jsonl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  writeFileSync(join(values.out, "train.jsonl"), jsonl(dataset.train));
  writeFileSync(join(values.out, "test.jsonl"), jsonl(dataset.test));
  writeFileSync(
    join(values.out, "manifest.json"),
    `${JSON.stringify(dataset.manifest, null, 2)}\n`,
  );
  console.log(
    `train ${dataset.train.length} rows, test ${dataset.test.length} rows -> ${values.out}`,
  );
  console.log(`questions: ${dataset.manifest.questionSet}`);
  console.log(`held out: ${dataset.manifest.heldOutClasses.join(", ")}`);
  console.log(
    `left out of training: ${dataset.manifest.droppedSeededFromTest} synthetic row(s) seeded from test episodes`,
  );
  console.log(JSON.stringify(dataset.manifest.labels, null, 2));
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
