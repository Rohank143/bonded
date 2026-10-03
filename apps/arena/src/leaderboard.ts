import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Attestation, Leaderboard, LeaderboardEntry } from "@bonded/shared";
import type { RatingReport } from "./rate.js";

/** The published leaderboard (served by GET /leaderboard). */
export const LEADERBOARD_FILE = fileURLToPath(
  new URL("../../../config/leaderboard.json", import.meta.url),
);

export function readLeaderboard(path = LEADERBOARD_FILE): LeaderboardEntry[] {
  return Leaderboard.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeLeaderboard(entries: LeaderboardEntry[], path = LEADERBOARD_FILE): void {
  const sorted = [...Leaderboard.parse(entries)].sort(
    (a, b) => b.score - a.score || a.slug.localeCompare(b.slug),
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * A rating as a leaderboard entry: class-level results only. The report's worst-case list
 * (which seeds breached) and the traces stay out, per the disclosure policy.
 */
export function entryFromRating(
  report: RatingReport,
  reportHash: string,
  meta: Pick<
    LeaderboardEntry,
    "slug" | "name" | "kind" | "framework" | "model" | "onchain" | "disclosure"
  > & { template?: string },
): LeaderboardEntry {
  return LeaderboardEntry.parse({
    ...meta,
    ratedAt: report.startedAt,
    score: report.scoring.score,
    tier: report.scoring.tier,
    expectedLossBps: report.scoring.expectedLossBps,
    premiumRateBps: report.scoring.premiumRateBps,
    insurable: report.scoring.insurable,
    episodes: {
      attacks: report.episodes.attacks,
      controls: report.controls.episodes,
      controlBreaches: report.controls.breaches,
    },
    classes: report.classes.map((c) => ({
      class: c.class,
      name: c.name,
      episodes: c.episodes,
      breaches: c.breaches,
    })),
    reportHash,
  });
}

/** Insert or replace the entry with the same slug. */
export function upsertEntry(entries: LeaderboardEntry[], entry: LeaderboardEntry) {
  return [...entries.filter((e) => e.slug !== entry.slug), entry];
}

/** The attestation a rating signed, as the cross-poster reads it. */
export function ratingAttestation(file: string): { attestation: Attestation; reportHash: string } {
  const a = JSON.parse(readFileSync(file, "utf8")) as {
    attestation: Attestation;
    reportHash: string;
  };
  return { attestation: a.attestation, reportHash: a.reportHash };
}
