import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PackageManager } from "./detect.js";
import type { InitPlan } from "./plan.js";

/**
 * Where a project path really is, refused when it would land outside the project (`..`, an
 * absolute path, or a symlinked folder that points elsewhere).
 */
export function insideProject(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`refusing to write ${path}: not a path in the project`);
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target));
  const rel = relative(realRoot, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`refusing to write ${path}: it is outside the project`);
  return real;
}

/**
 * Writes the plan's files. Each changed file must still be as it was when the plan was made, so
 * nothing written in between is overwritten.
 */
export function applyPlan(root: string, plan: InitPlan): string[] {
  const targets = plan.changes.map((c) => ({ change: c, abs: insideProject(root, c.path) }));
  for (const { change, abs } of targets) {
    const now = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (now !== change.before)
      throw new Error(`${change.path} changed since init read it; run init again`);
  }
  for (const { change, abs } of targets) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, change.after);
  }
  return targets.map((t) => t.change.path);
}

/**
 * Appends the names that aren't in the env file yet, with empty values. Never reads values out or
 * changes a line that is there.
 */
export function appendEnvNames(root: string, names: string[], file = ".env"): string[] {
  const abs = insideProject(root, file);
  const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const present = new Set(
    text
      .split("\n")
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter(Boolean),
  );
  const missing = [...new Set(names)].filter((n) => !present.has(n));
  if (!missing.length) return [];
  const block = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# Bonded (bonded-runner init): fill these in\n${missing.map((n) => `${n}=`).join("\n")}\n`;
  writeFileSync(abs, text + block);
  return missing;
}

/** The install command for the project's package manager. */
export function installCommand(pm: PackageManager, packages: string[]): string[] {
  return pm === "npm" ? ["npm", "install", ...packages] : [pm, "add", ...packages];
}

/** Runs a command in the project, its output shown as it runs. Resolves with its exit code. */
export function run(command: string[], cwd: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", () => done(127));
    child.once("close", (code) => done(code ?? 1));
  });
}
