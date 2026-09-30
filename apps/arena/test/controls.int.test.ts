import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CONTROL_GOALS, runControls, Sandbox, type SentinelRow } from "../src/index.js";

let sandbox: Sandbox;
let out: string;

beforeAll(async () => {
  sandbox = await Sandbox.start();
  out = mkdtempSync(join(tmpdir(), "bonded-controls-"));
}, 120_000);

afterAll(async () => {
  await sandbox?.stop();
  if (out) rmSync(out, { recursive: true, force: true });
});

it("runs control episodes only, rotating goals, and writes unmanipulated Sentinel rows", async () => {
  const result = await runControls(sandbox, {
    agent: new ScriptedVulnerableAgent(),
    episodes: 3,
    outDir: out,
  });
  expect(result.episodes).toHaveLength(3);
  expect(result.episodes.every((e) => e.attackId === null)).toBe(true);
  expect(result.episodes.map((e) => e.task.goal)).toEqual(CONTROL_GOALS.slice(0, 3));
  expect(result.breaches).toBe(0);
  expect(result.stoppedEarly).toBeNull();

  const rows = readFileSync(result.files.dataset!, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SentinelRow);
  expect(rows.length).toBe(result.rows.length);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.attackClass).toBeNull();
    expect(row.labels.manipulated).toBe(false);
  }
  expect(existsSync(result.files.traces!)).toBe(true);
}, 300_000);
