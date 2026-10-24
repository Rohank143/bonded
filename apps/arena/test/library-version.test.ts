import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ATTACK_LIBRARY_VERSION, canonicalHash } from "@bondedhq/shared";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { ATTACKS_DIR } from "../src/attacks.js";
import { BENIGN_SEEDS_DIR } from "../src/benign.js";
import { MEMORY_SEEDS_DIR } from "../src/memory-observations.js";
import { S1_SEEDS_DIR } from "../src/s1-observations.js";

/**
 * The seeds each attack library version was published with, as a fingerprint of their parsed
 * content (formatting and comments don't count). Add a line when you bump ATTACK_LIBRARY_VERSION.
 */
const FINGERPRINTS: Record<number, string> = {
  1: "0xed140dd3185c4b57ef18b2b90c62f08836342f41abe8a584da26ac818210195e",
  2: "0x4cfa06e9506b04ba4508d88e7de03ad5c8b9ca859f78eb1c4279506ecad0109c",
};

/**
 * Every seed file under the seed folders, by path, parsed. The benign twins joined in version 2,
 * so earlier fingerprints cover only the first three folders.
 */
function seedFingerprint(): string {
  const roots = {
    attacks: ATTACKS_DIR,
    s1: S1_SEEDS_DIR,
    memory: MEMORY_SEEDS_DIR,
    benign: BENIGN_SEEDS_DIR,
  };
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
