import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ATTACK_LIBRARY_VERSION, canonicalHash, TASK_SCORE_VERSION } from "@bondedhq/shared";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { ATTACKS_DIR } from "../src/attacks.js";
import { BENIGN_SEEDS_DIR, WORLD_TWINS_DIR } from "../src/benign.js";
import { MEMORY_SEEDS_DIR } from "../src/memory-observations.js";
import { S1_SEEDS_DIR } from "../src/s1-observations.js";
import { WORLD_SEEDS_DIR } from "../src/world-observations.js";

/**
 * The seeds each attack library version was published with, as a fingerprint of their parsed
 * content (formatting and comments don't count). Add a line when you bump ATTACK_LIBRARY_VERSION.
 */
const FINGERPRINTS: Record<number, string> = {
  1: "0xed140dd3185c4b57ef18b2b90c62f08836342f41abe8a584da26ac818210195e",
  2: "0x6ce472c351c788d855f276f6d4da5fcb5c456ed9fd517618b4198a07b3cec883",
};

/** The benign twins each Task score version was published with (TASK_SCORE_VERSION). */
const TASK_FINGERPRINTS: Record<number, string> = {
  1: "0x7669c441c2e3e2756da8ad07a0f5311bd7cf2167ddb6b7096f4dfbeda083e32d",
  2: "0x258cc54e65d1bfaf1d6c2378910794ca53acb3bd9cbb8619762251a9c9030025",
  3: "0x052add8a57c6ff6fd1cd257fe6bcb2b6bbb3066c7babb4e6a2b5125c4f48718e",
};

/** Every seed file under the given folders, by path, parsed. */
function fingerprint(roots: Record<string, string>): string {
  const files: { path: string; seed: unknown }[] = [];
  for (const [name, dir] of Object.entries(roots))
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      files.push({
        path: `${name}/${relative(dir, path)}`,
        seed: parse(readFileSync(path, "utf8")),
      });
    }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return canonicalHash(files);
}

/**
 * The attack library's seed folders. Version 1 had three; the world-state seeds joined in
 * version 2.
 */
function seedFingerprint(): string {
  return fingerprint({
    attacks: ATTACKS_DIR,
    s1: S1_SEEDS_DIR,
    memory: MEMORY_SEEDS_DIR,
    world: WORLD_SEEDS_DIR,
  });
}

it("bumps the attack library version whenever a seed changes", () => {
  const actual = seedFingerprint();
  const recorded = FINGERPRINTS[ATTACK_LIBRARY_VERSION];
  expect(
    actual,
    recorded === undefined
      ? `ATTACK_LIBRARY_VERSION is ${ATTACK_LIBRARY_VERSION} but has no fingerprint: add ${ATTACK_LIBRARY_VERSION}: "${actual}" to FINGERPRINTS in this file.`
      : `The attack, S1 or memory seeds changed since attack library version ${ATTACK_LIBRARY_VERSION}. ` +
          "Bump ATTACK_LIBRARY_VERSION in packages/shared/src/library-version.ts (note what changed in its history), " +
          `then add ${ATTACK_LIBRARY_VERSION + 1}: "${actual}" to FINGERPRINTS here. Ratings on the old version then show ` +
          "as older on the leaderboard until `pnpm --filter @bonded/arena leaderboard refresh` re-rates them (docs/SCORING.md).",
  ).toBe(recorded);
});

it("never reuses a version for different seeds", () => {
  const values = Object.values(FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
  expect(Math.max(...Object.keys(FINGERPRINTS).map(Number))).toBe(ATTACK_LIBRARY_VERSION);
});

it("bumps the Task score version whenever a benign twin changes", () => {
  // Version 3 added the world twins' folder.
  const actual = fingerprint({ benign: BENIGN_SEEDS_DIR, world: WORLD_TWINS_DIR });
  expect(
    actual,
    `The benign twins changed since Task score version ${TASK_SCORE_VERSION}. Bump TASK_SCORE_VERSION ` +
      "in packages/shared/src/library-version.ts (note what changed in its history), then add " +
      `${TASK_SCORE_VERSION + 1}: "${actual}" to TASK_FINGERPRINTS here.`,
  ).toBe(TASK_FINGERPRINTS[TASK_SCORE_VERSION]);
  const values = Object.values(TASK_FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
  expect(Math.max(...Object.keys(TASK_FINGERPRINTS).map(Number))).toBe(TASK_SCORE_VERSION);
});
