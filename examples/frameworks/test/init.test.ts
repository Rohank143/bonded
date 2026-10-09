import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { applyPlan, detectProject, planInit } from "@bondedhq/runner";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `bonded-runner init` on the runner's fixture projects, applied and typechecked against the real
 * frameworks and the built SDK. The copies go in this package (gitignored), so their imports
 * resolve to the versions installed here.
 */
const FIXTURES = join(import.meta.dirname, "../../../apps/runner/test/fixtures");
const WORK = join(import.meta.dirname, "../.init-typecheck");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

mkdirSync(WORK, { recursive: true });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function typecheck(dir: string): string {
  try {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--noEmit"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("bonded-runner init, applied", () => {
  it.each(["langchain", "ai-sdk", "agentkit"])(
    "%s: typechecks before and after, with the files init wrote",
    (name) => {
      const dir = mkdtempSync(join(WORK, `${name}-`));
      made.push(dir);
      cpSync(join(FIXTURES, name), dir, { recursive: true });
      expect(typecheck(dir), "the fixture itself").toBe("");
      const plan = planInit(detectProject(dir));
      expect(plan.manual).toEqual([]);
      expect(applyPlan(dir, plan).length).toBe(2);
      expect(typecheck(dir), "after init").toBe("");
    },
    120_000,
  );
});
