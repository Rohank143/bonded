#!/usr/bin/env node
/**
 * pnpm release:packages: publishes @bondedhq/shared, @bondedhq/solana, @bondedhq/sdk and @bondedhq/runner
 * to npm, in that order, with public access.
 *
 * 1. Refuses unless the tree is clean and on main, level with origin/main (what was reviewed).
 * 2. Builds the packages fresh and runs their tests.
 * 3. Packs them and smoke-tests the tarballs in an empty project (pnpm release:check).
 * 4. Publishes each one whose version isn't on npm yet (pnpm asks for your one-time password).
 *
 * `--dry-run` does everything except publish (pnpm publish --dry-run) and doesn't need main.
 * Bump versions in the packages' package.json (in a reviewed PR) before publishing again.
 */
import { buildPackages, PACKAGES, read, run, version } from "./packages.mjs";

const dryRun = process.argv.includes("--dry-run");

const branch = read("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = read("git", ["status", "--porcelain"]);
const problems = [];
if (dirty === undefined || branch === undefined) problems.push("this isn't a git checkout");
if (dirty) problems.push("the working tree has uncommitted changes");
if (branch !== "main") problems.push(`the branch is ${branch}, not main`);
if (!problems.length) {
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", "origin/main"]))
    problems.push("main isn't level with origin/main (pull, or push what was merged)");
}
if (problems.length && !dryRun) {
  console.error(`Not publishing: ${problems.join("; ")}.`);
  process.exit(1);
}
if (problems.length) console.warn(`Dry run despite: ${problems.join("; ")}.`);

buildPackages();
run("pnpm", ["turbo", "run", "test", ...PACKAGES.map((p) => `--filter=${p.name}`)]);
run("node", ["scripts/release/check.mjs", "--no-build"]);

for (const pkg of PACKAGES) {
  const v = version(pkg);
  const published = read("npm", ["view", `${pkg.name}@${v}`, "version"]);
  if (published === v) {
    console.log(`${pkg.name}@${v} is already on npm; skipping.`);
    continue;
  }
  run(
    "pnpm",
    ["publish", "--access", "public", ...(dryRun ? ["--dry-run", "--no-git-checks"] : [])],
    { cwd: new URL(`../../${pkg.dir}/`, import.meta.url) },
  );
}
console.log(dryRun ? "Dry run finished: nothing was published." : "Published.");
