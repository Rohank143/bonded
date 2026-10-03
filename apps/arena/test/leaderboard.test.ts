import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  entryFromRating,
  readLeaderboard,
  upsertEntry,
  writeLeaderboard,
} from "../src/leaderboard.js";
import type { RatingReport } from "../src/rate.js";

const report = {
  startedAt: "2026-10-03T12:00:00.000Z",
  scoring: {
    score: 31,
    tier: "CCC",
    expectedLossBps: 1500,
    premiumRateBps: 2100,
    insurable: false,
  },
  episodes: { total: 42, attacks: 40, controls: 2, agentErrors: 0 },
  controls: { episodes: 2, breaches: 0 },
  classes: [
    {
      class: "A2",
      name: "Injection via content",
      episodes: 4,
      agentErrors: 0,
      breaches: 3,
      attackSucceeded: 3,
      lossUsd: 15000,
    },
  ],
  worst: [
    {
      episodeId: "A2-fake-halt-news-001-1",
      attackId: "A2-fake-halt-news-001",
      lossUsd: 5000,
      breaches: ["T1_UNAUTHORIZED_TRANSFER"],
    },
  ],
} as unknown as RatingReport;

const meta = {
  slug: "agentkit-test",
  name: "AgentKit chatbot",
  kind: "framework" as const,
  framework: "Coinbase AgentKit",
  model: "deepseek/deepseek-v4.1-flash",
  onchain: null,
  disclosure: { status: "pending" as const },
};

it("publishes class-level results only, never which seeds broke the agent", () => {
  const e = entryFromRating(report, `0x${"ab".repeat(32)}`, meta);
  expect(e).toMatchObject({
    score: 31,
    episodes: { attacks: 40, controls: 2, controlBreaches: 0 },
    classes: [{ class: "A2", name: "Injection via content", episodes: 4, breaches: 3 }],
  });
  expect(JSON.stringify(e)).not.toContain("A2-fake-halt-news-001");
  expect(JSON.stringify(e)).not.toContain("lossUsd");
});

it("keeps one entry per slug, best score first", () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-"));
  try {
    const file = join(dir, "leaderboard.json");
    writeFileSync(file, "[]\n");
    const a = entryFromRating(report, `0x${"ab".repeat(32)}`, meta);
    const b = { ...a, slug: "other", score: 90 };
    writeLeaderboard(upsertEntry(upsertEntry(readLeaderboard(file), a), b), file);
    writeLeaderboard(upsertEntry(readLeaderboard(file), { ...a, score: 35 }), file);
    expect(readLeaderboard(file).map((e) => [e.slug, e.score])).toEqual([
      ["other", 90],
      ["agentkit-test", 35],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
