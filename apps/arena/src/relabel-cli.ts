#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRows, type SentinelRow, writeDataset } from "./dataset.js";
import type { EpisodeResult } from "./episode.js";
import { readSeedRows } from "./synthetic.js";

const USAGE = `Usage: pnpm --filter @bonded/arena relabel <rating dir> [<rating dir> ...]

Rebuilds a rating's sentinel-dataset.jsonl from its saved traces with the current labelling
rules (src/dataset.ts), keeping row order and rating ids, and prints what changed. Since v5 a
trade that does what the planted content orders is manipulated even inside the rules.`;

function relabel(dir: string): void {
  const path = join(dir, "sentinel-dataset.jsonl");
  const old = readSeedRows(path);
  const byId = new Map(old.map((r, i) => [r.id, { row: r, i }]));
  const traces = join(dir, "traces");
  const fresh: SentinelRow[] = readdirSync(traces)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) =>
      datasetRows(JSON.parse(readFileSync(join(traces, f), "utf8")) as EpisodeResult),
    );
  const missing = old.filter((r) => !fresh.some((f) => f.id === r.id));
  if (missing.length || fresh.length !== old.length)
    throw new Error(
      `${dir}: traces give ${fresh.length} rows, the dataset has ${old.length} (e.g. ${missing[0]?.id ?? "extra rows"}); not rewritten`,
    );
  const rows = fresh
    .map((r) => ({
      ...r,
      ...(byId.get(r.id)!.row.ratingId ? { ratingId: byId.get(r.id)!.row.ratingId } : {}),
    }))
    .sort((a, b) => byId.get(a.id)!.i - byId.get(b.id)!.i);
  const changes = new Map<string, number>();
  for (const r of rows) {
    const before = byId.get(r.id)!.row.labels;
    for (const k of ["manipulated", "action_risk", "injection_in_inputs"] as const)
      if (before[k] !== r.labels[k]) {
        const key = `${k}: ${String(before[k])} -> ${String(r.labels[k])}`;
        changes.set(key, (changes.get(key) ?? 0) + 1);
      }
  }
  writeDataset(path, rows);
  console.log(`${dir}: ${rows.length} rows`);
  for (const [k, n] of changes) console.log(`  ${k}: ${n}`);
  if (!changes.size) console.log("  no label changed");
}

const dirs = process.argv.slice(2);
if (!dirs.length || dirs[0] === "--help") {
  console.log(USAGE);
  process.exit(dirs.length ? 0 : 2);
}
try {
  for (const d of dirs) relabel(d);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
